import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { localObsURL, obsConnection, prepareOBS, launchAndPrepareOBS, ensurePlatformSource, ensurePortraitVideo, PHONE_VIDEO, withOBS } from '../obs.mjs';

test('OBS rejects remote URLs and credentials in the address', () => {
  assert.equal(localObsURL('ws://127.0.0.1:4455'),'ws://127.0.0.1:4455/');
  for(const url of ['ws://example.org:4455','https://localhost','ws://user:secret@localhost','ws://localhost/private','ws://localhost?password=secret'])assert.throws(()=>localObsURL(url));
});
test('real npm client authenticates and controls virtual camera via RPC without recording or streaming', async t => {
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>server.once('listening',r));
  t.after(async()=>{for(const c of server.clients)c.terminate();await new Promise(r=>server.close(r));});
  const calls=[];let active=false;
  const hash=s=>createHash('sha256').update(s).digest('base64');
  server.on('connection',socket=>{
    socket.send(JSON.stringify({op:0,d:{obsWebSocketVersion:'5.6.3',rpcVersion:1,authentication:{salt:'salt',challenge:'challenge'}}}));
    socket.on('message',bytes=>{
      const {op,d}=JSON.parse(bytes.toString());
      if(op===1){assert.equal(d.authentication,hash(hash('fixture-passwordsalt')+'challenge'));socket.send(JSON.stringify({op:2,d:{negotiatedRpcVersion:1}}));return;}
      assert.equal(op,6);calls.push(d.requestType);let responseData={};
      if(d.requestType==='GetVirtualCamStatus')responseData={outputActive:active};
      else if(d.requestType==='StartVirtualCam')active=true;else assert.fail(`Unexpected RPC ${d.requestType}`);
      socket.send(JSON.stringify({op:7,d:{requestType:d.requestType,requestId:d.requestId,requestStatus:{result:true,code:100},responseData}}));
    });
  });
  const connection={url:`ws://127.0.0.1:${server.address().port}`,password:'fixture-password'};
  assert.deepEqual(await prepareOBS({connection}),{connected:true,virtualCameraActive:true});
  assert.deepEqual(calls,['GetVirtualCamStatus','StartVirtualCam','GetVirtualCamStatus']);
  calls.length=0;await prepareOBS({connection});assert.deepEqual(calls,['GetVirtualCamStatus']);
});
test('source setup reuses and repairs a hidden or undersized platform source', async () => {
  const calls=[];
  const call=async(type,data)=>{calls.push({type,data});
    if(type==='GetSceneList')return{currentProgramSceneName:'scene'};
    if(type==='GetSceneItemList')return{sceneItems:[{inputKind:'browser_source',sourceName:'Existing platform',sceneItemId:2},{inputKind:'ffmpeg_source',sourceName:'Other media',sceneItemId:3}]};
    if(type==='GetVideoSettings')return{baseWidth:1920,baseHeight:1080};
    if(type==='GetInputSettings')return{inputSettings:{url:'http://127.0.0.1:3070/studio/output'}};
    if(['SetInputSettings','SetSceneItemEnabled','SetSceneItemTransform','SetSceneItemIndex'].includes(type))return{};
    throw Error('Unexpected mutation '+type);
  };
  assert.deepEqual(await ensurePlatformSource(call),{sceneName:'scene',inputName:'Existing platform',reused:true});
  assert.equal(calls.find(c=>c.type==='SetSceneItemEnabled').data.sceneItemEnabled,true);
  const transform=calls.find(c=>c.type==='SetSceneItemTransform').data.sceneItemTransform;
  assert.equal(transform.boundsWidth,1920);assert.equal(transform.boundsHeight,1080);
  assert.equal(calls.find(c=>c.type==='SetSceneItemIndex').data.sceneItemIndex,1);
  assert.ok(!calls.some(c=>/Create|Remove/.test(c.type)));
  assert.ok(calls.filter(c=>c.type.startsWith('SetScene')).every(c=>c.data.sceneItemId===2));
});
test('new source avoids collisions, fits canvas and preserves unrelated sources',async()=>{
 const calls=[];const call=async(type,data)=>{calls.push({type,data});return{GetSceneList:{currentProgramSceneName:'scene'},GetSceneItemList:{sceneItems:[]},GetInputList:{inputs:[{inputName:'WeCom 平台输出'}]},GetVideoSettings:{baseWidth:1280,baseHeight:720},CreateInput:{sceneItemId:9},SetSceneItemTransform:{}}[type];};
 assert.equal((await ensurePlatformSource(call)).inputName,'WeCom 平台输出 2');
 const created=calls.find(c=>c.type==='CreateInput').data;assert.equal(created.inputSettings.width,1280);assert.equal(created.inputSettings.reroute_audio,false);
 assert.equal(calls.some(c=>/Remove|StartRecord|StartStream/.test(c.type)),false);
});
test('first OBS scene is created when no current scene exists', async () => {
  const calls=[];
  const call=async(type,data)=>{
    calls.push({type,data});
    return {GetSceneList:{currentProgramSceneName:''},GetSceneItemList:{sceneItems:[]},GetInputList:{inputs:[]},GetVideoSettings:PHONE_VIDEO,CreateInput:{sceneItemId:1}}[type] || {};
  };
  const result=await ensurePlatformSource(call);
  assert.equal(result.sceneName,'企微转接');
  assert.deepEqual(calls.find(c=>c.type==='CreateScene').data,{sceneName:'企微转接'});
  assert.ok(calls.some(c=>c.type==='SetCurrentProgramScene'));
});
test('explicit platform preparation refreshes the existing browser before checking virtual camera',async()=>{
 const calls=[];
 const client={on(){},async connect(){},async disconnect(){},async call(type,data){
  calls.push({type,data});
  return {GetSceneList:{currentProgramSceneName:'scene'},GetSceneItemList:{sceneItems:[{inputKind:'browser_source',sourceName:'platform',sceneItemId:7}]},GetVideoSettings:PHONE_VIDEO,GetInputSettings:{inputSettings:{url:'http://127.0.0.1:3070/studio/output'}},GetVirtualCamStatus:{outputActive:true}}[type]||{};
 }};
 await prepareOBS({configureSource:true,refreshSource:true,client,connection:{url:'ws://127.0.0.1:4455'}});
 assert.deepEqual(calls.find(c=>c.type==='PressInputPropertiesButton').data,{inputName:'platform',propertyName:'refreshnocache'});
 assert.ok(calls.findIndex(c=>c.type==='PressInputPropertiesButton')<calls.findIndex(c=>c.type==='GetVirtualCamStatus'));
 assert.ok(!calls.some(c=>/Remove|StartRecord|StartStream/.test(c.type)));
});
test('portrait video resets the active virtual camera and restores it even if video settings fail',async()=>{
 for(const fail of [false,true]){
  const calls=[];const call=async(type,data)=>{
   calls.push({type,data});
   if(type==='GetVideoSettings')return{baseWidth:1920,baseHeight:1080,outputWidth:1280,outputHeight:720};
   if(type==='GetStreamStatus'||type==='GetRecordStatus')return{outputActive:false};
   if(type==='GetVirtualCamStatus')return{outputActive:true};
   if(type==='SetVideoSettings'&&fail)throw Error('reset failed');
   return{};
  };
  if(fail)await assert.rejects(ensurePortraitVideo(call),/reset failed/);else await ensurePortraitVideo(call);
  assert.equal(calls.filter(c=>c.type==='StopVirtualCam').length,1);
  assert.equal(calls.at(-1).type,'StartVirtualCam');
  assert.ok(calls.findIndex(c=>c.type==='StopVirtualCam')<calls.findIndex(c=>c.type==='SetVideoSettings'));
  assert.deepEqual(calls.find(c=>c.type==='SetVideoSettings').data,PHONE_VIDEO);
 }
});
test('portrait reset retries while the virtual camera releases the video subsystem',async()=>{
 let sets=0,started=false;
 await ensurePortraitVideo(async type=>{
  if(type==='GetVideoSettings')return{};
  if(type==='GetStreamStatus'||type==='GetRecordStatus')return{outputActive:false};
  if(type==='GetVirtualCamStatus')return{outputActive:true};
  if(type==='SetVideoSettings'&&++sets===1)throw Error('video still stopping');
  if(type==='StartVirtualCam')started=true;
  return{};
 });
 assert.equal(sets,2);assert.equal(started,true);
});
test('portrait setup leaves already correct settings alone and refuses to reset live recording',async()=>{
 const calls=[];
 await ensurePortraitVideo(async type=>{calls.push(type);return PHONE_VIDEO;});assert.deepEqual(calls,['GetVideoSettings']);
 const refused=[];
 await assert.rejects(ensurePortraitVideo(async type=>{refused.push(type);return type==='GetVideoSettings'?{}:{outputActive:true};}),/正在直播或录制/);
 assert.ok(!refused.some(type=>type.startsWith('Set')||type==='StopVirtualCam'));
});
test('connection timeout disconnects and SDK errors never expose secrets',async()=>{
 let closed=false;const client={on(){},connect:()=>new Promise(()=>{}),disconnect:async()=>{closed=true;}};
 const connection={url:'ws://127.0.0.1:4455',password:'private'};
 await assert.rejects(withOBS(()=>{}, {client,connection,timeout:15}),/连接 OBS WebSocket 超时/);assert.equal(closed,true);
 client.connect=async()=>{throw Object.assign(new Error('private'),{code:4009});};
 await assert.rejects(withOBS(()=>{}, {client,connection}),e=>!e.message.includes('private')&&e.message.includes('认证失败'));
});

test('automatic avatar start only checks the running camera without touching its renderer',async()=>{
 const calls=[];const client={on(){},async connect(){},async disconnect(){},async call(type){calls.push(type);if(type==='GetVirtualCamStatus')return{outputActive:true};throw Error('Unexpected call-time OBS operation: '+type);}};
 await prepareOBS({client,connection:{url:'ws://127.0.0.1:4455'}});
 assert.deepEqual(calls,['GetVirtualCamStatus']);
});

test('OBS connection uses supplied application settings and requires explicit credentials', async () => {
  await assert.rejects(obsConnection({ env: {} }), /\.env/);
  const env = { OBS_WEBSOCKET_URL: 'ws://127.0.0.1:4456', OBS_WEBSOCKET_PASSWORD: 'synthetic-password' };
  assert.deepEqual(await obsConnection({ env }), { url: 'ws://127.0.0.1:4456/', password: env.OBS_WEBSOCKET_PASSWORD });
});

test('OBS browser output follows the configured studio port', async () => {
  const previous = process.env.PORT;
  process.env.PORT = '4173';
  try {
    let created;
    await ensurePlatformSource(async (type, data) => {
      if (type === 'CreateInput') created = data;
      return { GetSceneList: { currentProgramSceneName: 'scene' }, GetSceneItemList: { sceneItems: [] }, GetInputList: { inputs: [] }, GetVideoSettings: PHONE_VIDEO, CreateInput: { sceneItemId: 1 } }[type] || {};
    });
    assert.equal(created.inputSettings.url, 'http://127.0.0.1:4173/studio/output');
  } finally { if (previous === undefined) delete process.env.PORT; else process.env.PORT = previous; }
});
test('camera activation rejection is not retried after OBS becomes reachable', async () => {
  let starts=0, opened=0;
  const client={on(){},async connect(){},async disconnect(){},async call(type){
    if(type==='GetVersion')return{};
    if(type==='GetVirtualCamStatus')return{outputActive:false};
    if(type==='StartVirtualCam'){starts++;throw Object.assign(new Error('extension rejected'),{code:500});}
    throw Error('Unexpected RPC '+type);
  }};
  await assert.rejects(launchAndPrepareOBS({openOBS:async()=>{opened++;},connection:{url:'ws://127.0.0.1:4455',password:'synthetic'},client}),/StartVirtualCam/);
  assert.equal(starts,1);assert.equal(opened,1);
});
test('inactive camera after a start request does not cause repeated activation dialogs', async () => {
  let starts=0;
  const client={on(){},async connect(){},async disconnect(){},async call(type){
    if(type==='GetVersion')return{};
    if(type==='GetVirtualCamStatus')return{outputActive:false};
    if(type==='StartVirtualCam'){starts++;return{};}
    throw Error('Unexpected RPC '+type);
  }};
  await assert.rejects(launchAndPrepareOBS({openOBS:async()=>{},connection:{url:'ws://127.0.0.1:4455',password:'synthetic'},client}),/未确认虚拟摄像头/);
  assert.equal(starts,1);
});
test('read-only API readiness retries do not activate the camera before OBS is ready', async () => {
  let connections=0, starts=0;
  const client={on(){},async connect(){if(++connections===1)throw Error('not listening yet');},async disconnect(){},async call(type){
    if(type==='GetVersion')return{};
    if(type==='GetVirtualCamStatus')return{outputActive:starts>0};
    if(type==='StartVirtualCam'){starts++;return{};}
    throw Error('Unexpected RPC '+type);
  }};
  const result=await launchAndPrepareOBS({openOBS:async()=>{},connection:{url:'ws://127.0.0.1:4455',password:'synthetic'},client});
  assert.equal(result.virtualCameraActive,true);assert.equal(starts,1);assert.equal(connections,3);
});
test('camera restoration after a canvas reset does not retry extension rejection', async () => {
  let starts=0;
  await assert.rejects(ensurePortraitVideo(async type=>{
    if(type==='GetVideoSettings')return{};
    if(type==='GetStreamStatus'||type==='GetRecordStatus')return{outputActive:false};
    if(type==='GetVirtualCamStatus')return{outputActive:true};
    if(type==='StartVirtualCam'){starts++;throw Error('signature invalid');}
    return{};
  }),/signature invalid/);
  assert.equal(starts,1);
});
