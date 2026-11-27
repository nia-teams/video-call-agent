import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, unlink, rmdir, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchAndPrepareOBS } from '../../media/obs.mjs';
import { initializeOBSWebSocket } from '../../media/obs-bootstrap.mjs';
import { autoCaptureEnabled, cameraSwitchArgs, createCallAutomation, createAudioCallFallback, cameraSwitchForEvent } from './call-automation.mjs';
import { createCameraSelection } from './camera-selection.mjs';
import { isMainModule, loadEnv, studioBase } from '../../env.mjs';
const isMain = isMainModule(import.meta.url);
if (isMain && process.argv[2] !== '--stop') {
  try { loadEnv({ requireOBS: true }); }
  catch (error) { console.error(error.message); process.exit(1); }
}
const execute=promisify(execFile);
const directory=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(directory,'../..');
const runtime=path.join(root,'.runtime/media-studio');
const base=studioBase();
const lock=path.join(runtime,'launcher.lock');
const statusPath=path.join(runtime,'auto-audio.json');
const audioBinary=path.join(directory,'.build/AutoAudio');
const cameraBinary=path.join(directory,'.build/CameraSwitch');
const probe=path.join(root,'media/native/.build/AudioProbe');
const children=new Set();
let closing=false, audio=null, audioReady=false, message='正在启动音频输出', lastSource='', sequence=0;
let interval=null, streamAbort=null, statusBusy=false, pollBusy=false, log=null, lastCallDetectionError='';
let autoCall={id:'',phase:'waiting',message:'等待企微来电',windowID:null};
const cameraSelection=createCameraSelection({
  launch: args=>child(cameraBinary,args),
  output: (data,isError)=>(isError?process.stderr:process.stdout).write(data),
  error: message=>{if(!closing)note(message);},
});
const calls=createCallAutomation({enabled:autoCaptureEnabled(),state,command:bridgeCommand,changed:value=>{autoCall=value;note(value.message);void status().catch(()=>{});}});
const audioCalls=createAudioCallFallback({
  probe: async()=>JSON.parse((await execute(probe,[],{timeout:12000})).stdout),
  windows: ()=>bridgeCommand('windows'),
  event: value=>{
    void calls.event(value);
    if(value.event==='call_ended')cameraSelection.cancel();
    const args=cameraSwitchForEvent(value);
    if(args)cameraSelection.start(args);
  },
});
async function bridgeCommand(endpoint, payload={}) {
  const current=await state();
  const response=await fetch(`${base}/bridge/${endpoint}`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Studio-Token':current.csrfToken},body:JSON.stringify(payload),signal:AbortSignal.timeout(25000)});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'自动采集操作失败');return result;
}
function note(text){console.log(text);log?.write(`${new Date().toISOString()} ${text}\n`);}
function child(program,args,options={}){
  const process=spawn(program,args,{cwd:root,stdio:['ignore','pipe','pipe'],...options});children.add(process);
  process.on('error',error=>note(`子程序启动失败：${error.message}`));
  process.on('exit',()=>children.delete(process));
  process.stdout?.on('data',data=>log?.write(data));process.stderr?.on('data',data=>log?.write(data));
  return process;
}
async function state(){
  const response=await fetch(`${base}/bridge/state`,{signal:AbortSignal.timeout(2500),redirect:'error'});
  if(!response.ok)throw new Error('媒体服务未就绪');
  const value=await response.json();
  if(value.service!=='video-call-agent'||!value.source||typeof value.csrfToken!=='string')throw new Error(`${new URL(base).port} 端口不是新版 Video Call Agent 服务，请先关闭占用该端口的旧服务`);
  return value;
}
export function sourceKey(source){return JSON.stringify([source.kind,source.url,source.revision,source.startedAt,source.playing,source.loop]);}
export function sourceMessage(source,revision){return {op:'source',kind:source.kind,revision,playing:source.playing,loop:source.loop,startedAt:source.startedAt};}
function send(value){
  if(!audio?.stdin?.writable||audio.stdin.writableLength>600000)return false;
  audio.stdin.write(`${JSON.stringify(value)}\n`);return true;
}
async function status(){
  if(statusBusy||closing)return;statusBusy=true;
  try{const temporary=`${statusPath}.${process.pid}.tmp`;await writeFile(temporary,JSON.stringify({pid:process.pid,updatedAt:Date.now(),active:audioReady,message,autoCall}),{mode:0o600});await rename(temporary,statusPath);}finally{statusBusy=false;}
}
async function poll(){
  if(pollBusy||closing)return;pollBusy=true;
  try{
    const current=await state(), key=sourceKey(current.source);
    if(key!==lastSource){
      if(send(sourceMessage(current.source,++sequence)))lastSource=key;
      if(current.source.kind==='url'){message='远程直链的自动音频暂不支持，请上传文件或使用 PCM API';note(message);}
    }
    if(autoCaptureEnabled() && (!autoCall.id || autoCall.id.startsWith('audio-window-') || ['ended','error'].includes(autoCall.phase))) {
      try { await audioCalls.poll(); lastCallDetectionError=''; }
      catch(error) {
        if(error.message!==lastCallDetectionError)note(`通话状态检测未完成：${error.message}`);
        lastCallDetectionError=error.message;
      }
    }
  }catch(error){
    if(lastSource){send({op:'stop'});lastSource='';note(`媒体服务断开，已暂停自动音频：${error.message}`);}
  }finally{pollBusy=false;await status().catch(error=>note(`状态写入失败：${error.message}`));}
}
async function pcmLoop(){
  while(!closing){
    streamAbort=new AbortController();
    try{
      const response=await fetch(`${base}/bridge/audio/outgoing`,{signal:streamAbort.signal,redirect:'error'});
      if(!response.ok||!response.body)throw new Error('PCM 订阅失败');
      const decoder=new TextDecoder();let pending='';
      for await(const chunk of response.body){
        pending+=decoder.decode(chunk,{stream:true});
        if(pending.length>600000)throw new Error('PCM 消息过大');
        let end;
        while((end=pending.indexOf('\n\n'))>=0){
          const event=pending.slice(0,end);pending=pending.slice(end+2);
          if(event.startsWith('data: ')){
            const packet=JSON.parse(event.slice(6));
            if(packet.sampleRate===48000&&packet.channels===2&&typeof packet.pcm==='string'&&packet.pcm.length<=256000)send({op:'pcm',pcm:packet.pcm});
          }
        }
      }
    }catch(error){if(!closing)note(`PCM 流等待重连：${error.message}`);}
    if(!closing)await new Promise(resolve=>setTimeout(resolve,1500));
  }
}
async function shutdown(code=0){
  if(closing)return;closing=true;
  if(interval)clearInterval(interval);streamAbort?.abort();calls.close();cameraSelection.cancel();
  await bridgeCommand('recordings/stop').catch(()=>{});
  audio?.stdin?.end();
  for(const process of children)process.kill('SIGTERM');
  await Promise.allSettled([...children].map(process=>new Promise(resolve=>{
    if(process.exitCode!==null)return resolve();
    const timeout=setTimeout(()=>{process.kill('SIGKILL');resolve();},4000);
    process.once('exit',()=>{clearTimeout(timeout);resolve();});
  })));
  while(statusBusy)await new Promise(resolve=>setTimeout(resolve,25));
  try{const existing=JSON.parse(await readFile(statusPath,'utf8'));if(existing.pid===process.pid)await unlink(statusPath);}catch{}
  await unlink(path.join(lock,'pid')).catch(()=>{});await rmdir(lock).catch(()=>{});
  note('已停止本次自动音频和摄像头监控；OBS、企微及复用的 Node 服务保持运行。');
  if(log)await new Promise(resolve=>log.end(resolve));process.exit(code);
}
async function acquire(){
  await mkdir(runtime,{recursive:true});
  try{await mkdir(lock);}catch(error){
    if(error.code!=='EEXIST')throw error;
    let pid;try{pid=Number(await readFile(path.join(lock,'pid'),'utf8'));}catch{}
    if(Number.isInteger(pid)&&pid>0){
      try{process.kill(pid,0);return false;}catch(error){if(error.code!=='ESRCH')throw error;}
    }else{throw new Error('启动锁尚未写完；请稍后重试，或检查 .runtime/media-studio/launcher.lock');}
    await unlink(path.join(lock,'pid'));await rmdir(lock);await mkdir(lock);
  }
  await writeFile(path.join(lock,'pid'),String(process.pid),{mode:0o600});return true;
}
async function start(){
  if(!await acquire()){console.log('一键启动器已运行，请查看原启动窗口。');return;}
  process.on('SIGINT',()=>void shutdown());process.on('SIGTERM',()=>void shutdown());process.on('SIGHUP',()=>void shutdown());
  process.stdout.on('error',()=>{}); // A closed launcher window still needs cleanup.
  try{
    log=(await open(path.join(runtime,'one-click.log'),'w',0o600)).createWriteStream();
    const audioDevices=JSON.parse((await execute(probe,[],{timeout:12000})).stdout);
    if(audioDevices.nodeMicInstalled!==true||audioDevices.nodeSendInstalled!==true)throw new Error('新版 Node Audio Send 或 Node Virtual Mic 未加载。请运行 npm run setup:check；需要更新 AudioProbe 时请重新运行 npm run setup。');
    await execute(probe,['--repair-output'],{timeout:12000});
    const {stdout}=await execute(probe,['--select-node-mic'],{timeout:12000});const devices=JSON.parse(stdout);
    if(devices.nodeMicSelected!==true)throw new Error('未能按设备 UID 选择新版 Node Virtual Mic，请在系统设置中检查默认输入');
    note(`系统话筒：Node Virtual Mic；系统扬声器：${devices.defaultOutput.join(' / ')}。`);
    try{const current=await state();
      const listener=(await execute('/usr/sbin/lsof',[`-tiTCP:${new URL(base).port}`,'-sTCP:LISTEN'],{timeout:5000})).stdout.trim();
      const serviceCommand=/^\d+$/.test(listener)?(await execute('/bin/ps',['-p',listener,'-o','command='])).stdout.trim():'';
      const legacyService=serviceCommand.endsWith(path.join(root,'web/media/server.mjs'));
      if(current.protocolVersion!==7||!current.recordings||legacyService){
      const {stdout}=await execute('/usr/sbin/lsof',[`-tiTCP:${new URL(base).port}`,'-sTCP:LISTEN'],{timeout:5000});
      const pid=Number(stdout.trim());
      if(!Number.isInteger(pid)||pid<=0)throw new Error('旧服务 PID 不明确，请先停止旧媒体服务');
      const running=(await execute('/bin/ps',['-p',String(pid),'-o','command='])).stdout.trim();
      if(![path.join(root,'media/server.mjs'),path.join(root,'web/media/server.mjs')].some(file=>running.endsWith(file)))throw new Error(`${new URL(base).port} 不是本项目的服务，无法自动更新`);
      const info=JSON.parse((await execute(probe,[],{timeout:12000})).stdout);
      if(info.processes?.some(p=>p.bundle.startsWith('com.tencent.WeWorkMac')&&p.inputActive))throw new Error('正在企微通话，请挂断后重新启动以更新旧服务');
      note('检测到旧媒体服务，正在更新录音与音频路由支持。');process.kill(pid,'SIGTERM');
      for(let i=0;i<50;i++){try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')break;throw e;}await new Promise(r=>setTimeout(r,100));}
      throw new Error('已关闭旧服务，开始启动新版');
    }note('复用已运行的本地 Node 媒体服务。');}catch(error){
      // Do not claim an unrelated service or start another instance on its port.
      if(error.message.includes('不是新版')||error.message.includes('PID 不明确')||error.message.includes('不是本项目')||error.message.includes('正在企微通话'))throw error;
      note('正在构建稳定运行版本，避免开发热更新中断通话。');
      const build=await execute(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'build','--webpack'],{cwd:root,env:{...process.env,STUDIO_BUILD:'1'},timeout:120000,maxBuffer:8*1024*1024});
      log?.write(build.stdout);log?.write(build.stderr);
      const server=child(process.execPath,[path.join(root,'media/server.mjs')],{cwd:root,env:{...process.env,NODE_ENV:'production'}});
      let ready=false;
      for(let i=0;i<90&&!closing;i++){
        if(server.exitCode!==null)throw new Error('Node 服务启动失败，请查看 one-click.log');
        try{await state();ready=true;break;}catch(error){if(error.message.includes('不是新版'))throw error;}
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
      if(!ready)throw new Error('等待 Node 媒体服务超时');note('Node 媒体服务已启动。');
    }
    if ((await state()).source.kind === 'idle') {
      await bridgeCommand('source', { kind: 'avatar' });
      note('首次启动已默认选择 内置数字人。');
    }
    audio=child(audioBinary,[path.join(runtime,'source.mp4')],{stdio:['pipe','pipe','pipe']});
    audio.stdin.on('error',error=>{if(!closing)note(`音频输入断开：${error.message}`);});
    let pending='';
    audio.stdout.on('data',data=>{
      pending+=data.toString();let end;
      while((end=pending.indexOf('\n'))>=0){
        const line=pending.slice(0,end);pending=pending.slice(end+1);
        try{
          const value=JSON.parse(line);
          if(value.event==='ready'){audioReady=true;message='自动音频：Node 文件 / PCM → Node Audio Send → Node Virtual Mic';lastSource='';void poll();}
          if(value.event==='error'){audioReady=false;message=`自动音频错误：${value.message}`;note(message);}
          if(value.event==='source'&&value.playing){audioReady=true;message='自动音频：Node 文件 / PCM → Node Audio Send → Node Virtual Mic';note('已自动播放上传文件的声音 → Node Audio Send。');}
        }catch{}
      }
    });
    audio.on('exit',()=>{audioReady=false;if(!closing){message='自动音频组件已退出，请检查日志';note(message);void status();}});
    interval=setInterval(()=>void poll(),1500);void pcmLoop();
    await execute('/usr/bin/open',['-a','Google Chrome',`${base}/?launcher=1`]);
    // Repair and refresh the platform source after the local server is ready.
    // The AX helper watches genuine call windows for camera selection.
    try {
      const obsURL = new URL(process.env.OBS_WEBSOCKET_URL);
      if (await initializeOBSWebSocket({ port: Number(obsURL.port || (obsURL.protocol === 'wss:' ? 443 : 80)), password: process.env.OBS_WEBSOCKET_PASSWORD })) note('已按 .env 配置 OBS WebSocket 端口和密码认证。');
      await launchAndPrepareOBS({configureSource:true,refreshSource:true});
      note('已适配并刷新 OBS 平台浏览器源，确认虚拟摄像头运行。');
    } catch (error) {
      await execute('/usr/bin/open', ['-g', '-a', '/Applications/OBS.app']).catch(()=>{});
      note(`OBS API 配置未完成：${error.message}。通话监控与音频继续运行；视频发送需完成 OBS 配置。`);
    }
    const cameraArgs = cameraSwitchArgs();
    const camera = child(cameraBinary,cameraArgs);
    let cameraLines='';
    camera?.stdout.on('data',data=>{
      process.stdout.write(data);cameraLines+=data.toString();let end;
      while((end=cameraLines.indexOf('\n'))>=0){
        const line=cameraLines.slice(0,end);cameraLines=cameraLines.slice(end+1);
        if(line.startsWith('{')){try{void calls.event(JSON.parse(line));}catch{}}
      }
      if(cameraLines.length>16384)cameraLines='';
    });
    camera?.stderr.on('data',data=>process.stderr.write(data));
    camera?.on('exit',code=>{if(!closing&&code!==0)note('通话监控已退出，自动接听/采集/连接千问不可用。请在新电脑「系统设置 → 隐私与安全性 → 辅助功能」授权实际启动项目的终端或 CameraSwitch，然后重新启动。音频与 Node 服务继续运行。');});
    note(`控制台：${base}/\n${cameraArgs.includes('--auto-answer')?'自动接听已开启：只接听可唯一确认的一对一来电。':'自动接听已关闭，请手动接听。'}${autoCaptureEnabled()?'接通后自动采集，并连接网页中选定的语音模型（默认千问）。':'自动采集已关闭，请在网页手动选择采集窗口。'}\nControl+C 停止一键启动器。日志：${path.join(runtime,'one-click.log')}`);
  }catch(error){note(`启动失败：${error.message}`);await shutdown(1);}
}
async function stopExisting(){
  let pid;try{pid=Number(await readFile(path.join(lock,'pid'),'utf8'));}catch{console.log('没有正在运行的一键启动器。');return;}
  if(!Number.isInteger(pid)||pid<=0)throw new Error('启动器 PID 无效');
  let command;try{command=(await execute('/bin/ps',['-p',String(pid),'-o','command='])).stdout;}catch{console.log('启动器已经退出。');return;}
  // Accept the previous location so npm stop can stop a launcher running before migration.
  let owned=[fileURLToPath(import.meta.url),path.join(root,'web/automation/obs-wecom/media-launcher.mjs')].some(file=>command.includes(file));
  if(!owned && ['automation/obs-wecom/media-launcher.mjs','web/automation/obs-wecom/media-launcher.mjs'].some(file=>command.trim()===`${process.execPath} ${file}`)){
    const cwd=(await execute('/usr/sbin/lsof',['-a','-p',String(pid),'-d','cwd','-Fn'])).stdout;
    owned=cwd.split('\n').some(line=>line===`n${root}`||line===`n${path.join(root,'web')}`);
  }
  if(!owned)throw new Error('PID 已被其他程序复用，没有停止该进程');
  process.kill(pid,'SIGTERM');console.log('已通知一键启动器停止音频、监控及本次启动的 Node 服务；OBS 和企微保持打开。');
}
if(isMain){
  if(process.argv[2]==='--stop')await stopExisting();else await start();
}
