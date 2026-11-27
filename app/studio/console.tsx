'use client';
import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
const QwenPanel = dynamic(() => import('../qwen/panel'), { ssr: false });
import { command, OutputVideo, PcmMonitor, useStudio, studioHeaders } from './media';
import './studio.scss';
import { AnalyserMeter, BlackHoleMeter, IncomingMeter } from './levels';
import { isVirtualOutput, isExplicitDevice } from './audio-devices';
type VoiceProvider = 'none' | 'qwen' | 'live-canvas';
type CaptureWindow={id:number;title:string;width:number;height:number};
type SinkMedia=HTMLAudioElement & {setSinkId?:(id:string)=>Promise<void>};
type AudioStatus={defaultInput:string[];defaultOutput:string[];processes?:{bundle:string;input:string[];output:string[];inputActive:boolean}[]};
export default function Studio(){
  const [active,setActive]=useState(false);
  const [ownershipError,setOwnershipError]=useState('');
  useEffect(()=>{
    if(!navigator.locks){setActive(true);return;}
    const controller=new AbortController();
    let release:(()=>void)|undefined;
    void navigator.locks.request('wecom-studio-console',{mode:'exclusive',signal:controller.signal},async()=>{
      if(controller.signal.aborted)return;
      setActive(true);
      await new Promise<void>(resolve=>{release=resolve;});
    }).catch(()=>{if(!controller.signal.aborted)setOwnershipError('无法协调控制台页面，请关闭重复标签页后刷新。');});
    return()=>{controller.abort();release?.();};
  },[]);
  if(!active)return <div className="studio-root"><header className="studio-top"><strong>WeCom MEDIA STUDIO</strong></header><p role="status">{ownershipError||'媒体控制台已在另一标签页运行。关闭原标签页后，本页会自动接管。'}</p></div>;
  return <ActiveStudio/>;
}
function ActiveStudio(){
  const {state,error:connectionError}=useStudio();
  const [provider,setProvider]=useState<VoiceProvider>('qwen');
  const [visible,setVisible]=useState(true);
  useEffect(()=>{
    const update=()=>setVisible(!document.hidden);update();
    document.addEventListener('visibilitychange',update);
    return()=>document.removeEventListener('visibilitychange',update);
  },[]);
  const [deletedRecordings,setDeletedRecordings]=useState(()=>new Set<string>());
  const recordingPlayers=useRef(new Map<string,HTMLAudioElement>());
  const [pendingDelete,setPendingDelete]=useState<string|null>(null);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[url,setURL]=useState('');
  const [windows,setWindows]=useState<CaptureWindow[]>([]),[windowID,setWindowID]=useState('');
  const [devices,setDevices]=useState<MediaDeviceInfo[]>([]),[sink,setSink]=useState(''),[audioOn,setAudioOn]=useState(false);
  const [audioEpoch,setAudioEpoch]=useState(0);
  const [audioStatus,setAudioStatus]=useState<AudioStatus|null>(null);
  const [live,setLive]=useState(false),[liveVideo,setLiveVideo]=useState(false),[origin,setOrigin]=useState('');
  const media=useRef<MediaStream|null>(null),localVideo=useRef<HTMLVideoElement>(null),audio=useRef<SinkMedia|null>(null);
  const frameTimer=useRef<ReturnType<typeof setTimeout>|null>(null),liveAbort=useRef<AbortController|null>(null),cancelUpload=useRef<AbortController|null>(null);
  const outgoingAnalyser=useRef<AnalyserNode|null>(null);
  const audioGraph=useRef<{context:AudioContext & {setSinkId?:(deviceId:string)=>Promise<void>};source:MediaElementAudioSourceNode;analyser:AnalyserNode}|null>(null);
  useEffect(()=>{
    const id=state?.autoCall?.windowID;
    if(!id||!['capturing','ready'].includes(state?.autoCall?.phase||''))return;
    setWindowID(String(id));
    if(!windows.some(w=>w.id===id))setWindows(old=>[...old,{id,title:'自动选择的企微通话',width:0,height:0}]);
  },[state?.autoCall?.windowID,state?.autoCall?.phase,windows]);
  const src=state?.source;
  useEffect(()=>{
    setProvider(current=>src?.kind==='live-canvas'?'live-canvas':current==='live-canvas'?'none':current);
  },[src?.kind]);
  async function selectProvider(next:VoiceProvider){
    const videoKind=next==='live-canvas'?'live-canvas':next==='qwen'?'avatar':null;
    if(videoKind&&src?.kind!==videoKind){
      stopLive();
      await command('source',{kind:videoKind});
    }
    setProvider(next);
  }
  const autoAudio=state?.autoAudio?.active===true;
  const recordingEnabled=state?.recordings?.enabled===true;
  const recordings=state?.recordings?.items.filter(item=>!deletedRecordings.has(item.id))||[];
  async function act(fn:()=>Promise<unknown>){setBusy(true);setError('');setNotice('');try{await fn();}catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);}}
  async function deleteRecording(id:string){
    await act(async()=>{
      recordingPlayers.current.get(id)?.pause();
      await command('recordings/delete',{id});
      setDeletedRecordings(previous=>new Set([...previous,id]));
      setPendingDelete(null);
      setNotice('录音已删除。');
    });
  }
  function stopLive(){if(frameTimer.current)clearTimeout(frameTimer.current);liveAbort.current?.abort();media.current?.getTracks().forEach(t=>t.stop());media.current=null;setLive(false);setLiveVideo(false);}
  useEffect(()=>{setOrigin(location.origin);return()=>{if(frameTimer.current)clearTimeout(frameTimer.current);liveAbort.current?.abort();media.current?.getTracks().forEach(t=>t.stop());cancelUpload.current?.abort();};},[]);
  useEffect(()=>{setAudioOn(false);audio.current?.pause();},[src?.revision,sink]);
  useEffect(()=>{if(autoAudio){audio.current?.pause();setAudioOn(false);}},[autoAudio]);
  useEffect(()=>{if(autoAudio){const node=devices.find(d=>/Node Audio Send/i.test(d.label));if(node)setSink(node.deviceId);}},[autoAudio,devices]);
  useEffect(()=>{setAudioOn(false);setAudioEpoch(n=>n+1);return()=>{audioGraph.current?.source.disconnect();void audioGraph.current?.context.close();audioGraph.current=null;outgoingAnalyser.current=null;};},[src?.revision]);
  useEffect(()=>{const refresh=()=>void navigator.mediaDevices.enumerateDevices().then(d=>setDevices(d.filter(v=>v.kind==='audiooutput'))).catch(()=>{});refresh();navigator.mediaDevices.addEventListener('devicechange',refresh);return()=>navigator.mediaDevices.removeEventListener('devicechange',refresh);},[]);
  async function deviceAccess(){const stream=await navigator.mediaDevices.getUserMedia({audio:true});stream.getTracks().forEach(t=>t.stop());setDevices((await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='audiooutput'&&isExplicitDevice(d)));setNotice('设备名称已刷新；麦克风授权用于读取设备名称，此处没有持续采集麦克风。');}
  async function upload(file:File){
    stopLive();audio.current?.pause();if(file.size>256*1024*1024)throw new Error('视频不能超过 256MB');
    cancelUpload.current=new AbortController();const r=await fetch('/bridge/upload',{method:'POST',headers:await studioHeaders(file.type||'video/mp4'),body:file,signal:cancelUpload.current.signal});const result=await r.json();if(!r.ok)throw new Error(result.error);setNotice('视频已输入 Node 服务，OBS 浏览器源会自动切换。');
  }
  async function startLive(kind:'camera'|'window'){
    stopLive(); const controller=new AbortController();liveAbort.current=controller;
    try {
    const stream=kind==='camera'?await navigator.mediaDevices.getUserMedia({video:{width:1280,height:720},audio:false}):await navigator.mediaDevices.getDisplayMedia({video:{frameRate:15},audio:false});
    media.current=stream;setLive(true);setLiveVideo(true);
    const el=localVideo.current!;el.srcObject=stream;await el.play();await command('source',{kind:'live'});
    const canvas=document.createElement('canvas');const context=canvas.getContext('2d')!;
    stream.getVideoTracks()[0].addEventListener('ended',()=>{stopLive();void command('source',{kind:'idle'}).catch(()=>{});},{once:true});
    async function frame(){
      if(controller.signal.aborted)return;
      canvas.width=Math.min(1280,el.videoWidth||1280);canvas.height=Math.round(canvas.width*(el.videoHeight||720)/(el.videoWidth||1280));context.drawImage(el,0,0,canvas.width,canvas.height);
      const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/jpeg',0.75));
      try{if(blob&&!controller.signal.aborted){const r=await fetch('/bridge/frame/outgoing',{method:'POST',headers:await studioHeaders(),body:blob,signal:controller.signal});if(!r.ok)throw new Error('实时帧发送失败');}}catch(e){if(!controller.signal.aborted){setError(e instanceof Error?e.message:'视频发送失败');stopLive();}return;}
      if(!controller.signal.aborted)frameTimer.current=setTimeout(()=>void frame(),80);
    }void frame();
    } catch(e) {stopLive();throw e;}
  }
  async function playAudio(){
    const el=audio.current;if(!el||!src?.url)throw new Error('请先上传有声音的视频或填写视频直链');
    if(!sink||!isVirtualOutput(devices.find(d=>d.deviceId===sink)?.label||''))throw new Error('请选择 Node Audio Send（企微输入选 Node Virtual Mic），或 BlackHole 输出设备');
    if(!audioGraph.current){
      const context:AudioContext & {setSinkId?:(deviceId:string)=>Promise<void>}=new AudioContext();
      if(!context.setSinkId){await context.close();throw new Error('请使用支持 AudioContext 输出选择的新版 Chrome');}
      const source=context.createMediaElementSource(el),analyser=context.createAnalyser();analyser.fftSize=2048;
      source.connect(analyser);analyser.connect(context.destination);audioGraph.current={context,source,analyser};outgoingAnalyser.current=analyser;
    }
    const graph=audioGraph.current;await graph.context.setSinkId!(sink);await graph.context.resume();
    if(Number.isFinite(el.duration)&&el.duration>0)el.currentTime=((Date.now()-src.startedAt)/1000)%el.duration;
    await el.play();setAudioOn(true);
  }
  return <div className="studio-root">
    <header className="studio-top"><strong>WeCom <span>MEDIA STUDIO</span></strong>{/* <button type="button" role="switch" aria-checked={recordingEnabled} aria-label="通话自动录音" className="studio-recording-toggle" disabled={busy||!state?.recordings} onClick={()=>void act(()=>command('recordings/settings',{enabled:!recordingEnabled}))}>通话录音 <span>{recordingEnabled?'已开启':'已关闭'}</span></button> */}<span className={state?"studio-online":"studio-offline"}>{state?'● 本地服务已连接':'○ 等待服务'}</span></header>
    <div className="studio-heading"><div><small>LOCAL VIDEO & AUDIO BRIDGE</small><h1>企微媒体控制台</h1><p>把视频送入 OBS，把企微通话画面和声音接回网页。采集、录音或转接 AI 前，请告知并征得参与者同意。</p></div><label>语音模型 <select aria-label="语音模型" value={provider} disabled={busy} onChange={e=>void act(()=>selectProvider(e.target.value as VoiceProvider))}><option value="none">不连接 AI</option><option value="qwen">Qwen Omni 实时语音</option><option value="live-canvas">GPT-Live · Live Canvas</option></select></label><a className="studio-link" href="/studio/output" target="_blank" rel="noreferrer">打开 OBS 输出页 ↗</a></div>
    {(error||connectionError)?<div role="alert" className="studio-error">{error||connectionError}</div>:null}{notice?<div role="status" className="studio-notice">{notice}</div>:null}
    <div className="studio-grid">
      <div className="studio-video-column">
      <section className="studio-card"><div className="studio-title"><span>01 / 视频发送</span><b>网页 → Node → OBS → 企微</b></div>
        <div className={`studio-preview${src?.kind==='live-canvas'&&provider==='live-canvas'?' studio-live-canvas':''}`}><div style={{display:liveVideo?'block':'none',width:'100%',height:'100%'}}><video ref={localVideo} muted playsInline className="studio-picture"/></div>{src?.kind==='live-canvas'&&provider==='live-canvas'?<iframe key={src.revision} title="Live Canvas 控制台" src={`/live-canvas?sourceRevision=${src.revision}`} allow="microphone; autoplay" style={{width:'100%',height:'100%',border:0,display:'block'}}/>:!liveVideo&&visible?<OutputVideo source={src||null}/>:null}</div>
        <div className="studio-controls"><label className="studio-upload">选择视频文件<input disabled={busy} type="file" accept="video/mp4,video/webm,video/quicktime" onChange={e=>{const f=e.target.files?.[0];if(f)void act(()=>upload(f));e.target.value='';}}/></label><button disabled={busy} onClick={()=>void act(async()=>{stopLive();await command('source',{kind:'avatar'});})}>HeR 数字人</button><button disabled={busy} aria-pressed={src?.kind==='live-canvas'} onClick={()=>void act(async()=>{stopLive();await command('source',{kind:'live-canvas'});setProvider('live-canvas');setNotice('Live Canvas 已选中，开始通话或本地演示即可发送画板。');})}>Live Canvas</button><button disabled={busy||live} onClick={()=>void act(()=>startLive('camera'))}>实时摄像头</button><button disabled={busy||live} onClick={()=>void act(()=>startLive('window'))}>实时窗口</button><button disabled={busy} onClick={()=>void act(async()=>{stopLive();audio.current?.pause();await command('source',{kind:'idle'});})}>停止输出</button></div>
        <div className="studio-row"><input aria-label="视频直链" placeholder="https://… / MP4 或浏览器可播放直链" value={url} onChange={e=>setURL(e.target.value)}/><button disabled={busy||!url} onClick={()=>void act(async()=>{stopLive();await command('source',{kind:'url',url});})}>使用直链</button></div>
        <p>OBS 使用 1080×1920（9:16）手机竖屏画布与浏览器源，地址：<code>{origin}/studio/output</code>。启动虚拟摄像头，企微通话右上角选择 OBS Virtual Camera。</p>
      </section>
      <section className="studio-card"><div className="studio-title"><span>02 / 视频接收</span><b>企微窗口 → Node → Web</b></div>
        <div className="studio-preview">{visible&&state?.capture.running&&state.frames.incoming>0?<img src="/bridge/video/incoming" className="studio-picture" alt="选中的企微窗口实时画面"/>:<div className="studio-placeholder">{state?.capture.running?'等待第一帧':'尚未开始窗口采集'}</div>}</div>
        <div className="studio-controls"><button disabled={busy} onClick={()=>void act(async()=>{const list=await command('windows') as CaptureWindow[];setWindows(list);setWindowID('');setNotice(list.length?'请选择视频通话窗口，再开始采集。':'未找到可见企微窗口，请先打开企微。');})}>读取企微窗口</button><select aria-label="采集的企微窗口" value={windowID} onChange={e=>setWindowID(e.target.value)}><option value="">请选择窗口</option>{windows.map(w=><option key={w.id} value={w.id}>{w.title||'企微未命名窗口'}{w.width>0?` · ${w.width}×${w.height}`:''}</option>)}</select></div>
        <div className="studio-controls"><button disabled={busy||!windowID||state?.capture.running} onClick={()=>void act(()=>command('capture/start',{windowID:Number(windowID)}))}>开始画面与音频采集</button><button disabled={busy} onClick={()=>void act(()=>command('capture/stop'))}>停止采集</button></div>
        <p>首次需在 macOS「屏幕与系统音频录制」中授权。只上传所选窗口的视频，以及企微应用的播放音频。</p>{state?.capture.error?<div className="studio-error">{state.capture.error}</div>:null}
      </section>
      </div>
      <section className="studio-card"><div className="studio-title"><span>03 / 音频发送</span><b>Node / 视频声音 → 虚拟话筒 → 企微</b></div><div className="studio-audio-icon">↗ <span>VIRTUAL MICROPHONE</span></div>
        {state?.autoAudio?<p role="status">{state.autoAudio.message}。自动音频运行时无需再次点网页播放；上传视频会自动切换声音。关闭一键启动窗口或按 Control+C 停止自动音频。</p>:null}
        <div className="studio-controls"><button disabled={busy} onClick={()=>void act(async()=>{const status=await command('audio/prepare') as AudioStatus;setAudioStatus(status);setNotice(`默认输入：${status.defaultInput.join(' / ')}。请核对企微实际使用的设备。`);})}>准备虚拟麦克风</button><button disabled={busy} onClick={()=>void act(async()=>setAudioStatus(await command('audio/status')))}>检查企微实际音频设备</button><button disabled={busy} onClick={()=>void act(async()=>{audio.current?.pause();setAudioOn(false);setAudioStatus(await command('audio/restore'));})}>恢复电脑麦克风</button></div>
        {audioStatus?<p>系统输入：{audioStatus.defaultInput.join(' / ')}；输出：{audioStatus.defaultOutput.join(' / ')}<br/>{audioStatus.processes?.filter(p=>p.bundle.startsWith('com.tencent.WeWorkMac')).map((p,i)=><span key={i}>企微实际输入：{p.input.join(' / ')||'尚未打开'}；实际输出：{p.output.join(' / ')||'尚未打开'}<br/></span>)}</p>:null}
        <div className="studio-controls"><button disabled={busy} onClick={()=>void act(deviceAccess)}>授权并刷新音频设备</button><select aria-label="发送音频的设备" value={sink} onChange={e=>setSink(e.target.value)}><option value="">选择 Node Audio Send / BlackHole</option>{devices.filter(d=>isVirtualOutput(d.label)).map(d=><option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}</select></div>
        <div className="studio-controls"><button disabled={autoAudio||busy||!sink||!src?.url} onClick={()=>audioOn?(audio.current?.pause(),setAudioOn(false)):void act(playAudio)}>{autoAudio?'一键启动正在输出音频':audioOn?'停止视频声音':'将视频声音送入企微'}</button><PcmMonitor channel="outgoing" sink={sink} onError={setError} disabled={autoAudio}/></div>
        <audio key={`${src?.revision}-${audioEpoch}`} ref={audio} crossOrigin={src?.kind==='url'?'anonymous':undefined} src={src?.url?`${src.url}${src.kind==='file'?`?v=${src.revision}`:''}`:undefined} loop={src?.loop} preload="metadata"/>
        <AnalyserMeter title="网页播放器 → 虚拟设备发送音量" analyser={outgoingAnalyser} note="测量播放器实际解码的音频；有电平只证明网页有输出，不等于对端已收到。远程直链需支持 CORS。"/>
        <BlackHoleMeter onError={setError}/>
        <p>本机驱动：{state?.blackHoleInstalled?'BlackHole 2ch 已安装':'未检测到 BlackHole 2ch'}。安装独立驱动后，网页输出选 <b>Node Audio Send</b>，企微输入选 <b>Node Virtual Mic</b>；否则使用 BlackHole 2ch。网页服务本身不会成为系统麦克风设备。服务重启后需要重新选择网页输出设备并开启声音；“检查”按钮显示企微实际使用的设备，而非只看系统默认值。</p>
      </section>
      <section className="studio-card"><div className="studio-title"><span>04 / 音频接收</span><b>企微播放音频 → Node → Web / API</b></div><div className="studio-audio-icon">↙ <span>APPLICATION AUDIO</span></div>
        <IncomingMeter enabled={visible&&!!state?.capture.running}/>
        <div className="studio-controls"><PcmMonitor channel="incoming" onError={setError}/></div><p>与窗口采集一起启停，音频采集范围是企微应用。监听使用浏览器默认扬声器；请使用耳机，勿把系统默认输出设置为 BlackHole，避免回送。</p>
        <div className="studio-stats"><div><strong>{state?.frames.incoming||0}</strong><span>接收视频帧</span></div><div><strong>{state?.audio.incoming||0}</strong><span>接收音频包</span></div><div><strong>{state?.frames.outgoing||0}</strong><span>实时发送帧</span></div><div><strong>{state?.audio.outgoing||0}</strong><span>API 发送音频包</span></div></div>
      </section>
      {provider==='qwen'?<QwenPanel studioState={state}/>:null}
      {recordingEnabled?<section className="studio-card"><div className="studio-title"><span>05 / 通话录音</span><b>本机录音 · 手动控制</b></div>
        <p>采集就绪后点击开始录音。左声道为企微播放声音，右声道为输入设备声音（含虚拟话筒）。请先取得参与者同意。显式启用自动采集时，可随通话开始和结束。</p>
        <div className="studio-controls"><button disabled={busy||!state?.capture.running||!!state?.recordings?.active} onClick={()=>void act(()=>command('recordings/start',{callID:crypto.randomUUID()}))}>开始录音</button><button disabled={busy||!state?.recordings?.active} onClick={()=>void act(()=>command('recordings/stop'))}>停止并保存</button></div>
        {state?.recordings?.active?<p role="status">● 正在录音 · 输入：{state.recordings.active.inputDevice} · 对方 / 本方采样包：{state.recordings.active.packets.join(' / ')}</p>:<p>等待开始录音</p>}
        {state?.recordings?.error?<p role="alert" className="studio-error">{state.recordings.error}</p>:null}
        {recordings.length?recordings.map(item=><div key={item.id} style={{borderTop:'1px solid #ddd',padding:'16px 0'}}>
          <p>{new Date(item.startedAt).toLocaleString('zh-CN')} · {Math.round(item.duration)} 秒 · {(item.bytes/1024/1024).toFixed(1)} MB</p>
          {item.warning?<p role="alert">{item.warning}</p>:null}
          <audio ref={element=>{if(element)recordingPlayers.current.set(item.id,element);else recordingPlayers.current.delete(item.id);}} controls preload="none" src={`/bridge/recordings/${item.id}.wav`} style={{width:'100%'}} aria-label="通话录音预览"/>
          <div className="studio-controls"><a className="studio-link" href={`/bridge/recordings/${item.id}.wav?download=1`} download>下载 WAV 录音 ↓</a>{pendingDelete===item.id?<><span className="studio-delete-prompt">删除这条录音及本机文件？</span><button type="button" className="studio-delete-recording" disabled={busy} onClick={()=>void deleteRecording(item.id)}>确认删除</button><button type="button" disabled={busy} onClick={()=>setPendingDelete(null)}>取消</button></>:<button type="button" className="studio-delete-recording" disabled={busy} onClick={()=>setPendingDelete(item.id)}>删除录音</button>}</div>
        </div>):<p>暂无录音，挂断后可在这里预览、下载或删除。</p>}
      </section>:null}
    </div><footer className="studio-footer">仅监听 127.0.0.1 · 通话录音本地保存 · 上传视频保留在本地 · 视频最高 15 FPS，音频为 48 kHz 双声道 PCM</footer>
  </div>;
}
