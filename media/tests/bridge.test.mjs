import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridge, byteRange, captureIsFresh } from '../bridge.mjs';

async function fixture(fn, bridgeOptions = {}) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'wecom-media-test-'));
  let bridge=createBridge({directory,helper:path.join(directory,'missing-helper'),port:0,...bridgeOptions});
  const server=http.createServer((req,res)=>void bridge.handle(req,res,new URL(req.url,`http://${req.headers.host}`)));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  let {csrfToken}=await (await fetch(base+'/bridge/state')).json();
  const restart=async()=>{bridge.close();bridge=createBridge({directory,helper:path.join(directory,'missing-helper'),port:0,...bridgeOptions});({csrfToken}=await(await fetch(base+'/bridge/state')).json());};
  const post=(p,data={},headers={})=>fetch(base+p,{method:'POST',headers:{Origin:base,'X-Studio-Token':csrfToken,'Content-Type':'application/json',...headers},body:typeof data==='string'||Buffer.isBuffer(data)?data:JSON.stringify(data)});
  try {await fn({base,post,restart,directory});} finally {bridge.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
}
test('byte ranges: open, suffix and unsatisfiable',()=>{
  assert.deepEqual(byteRange('bytes=2-5',10),{start:2,end:5});assert.deepEqual(byteRange('bytes=-3',10),{start:7,end:9});
  assert.deepEqual(byteRange('bytes=8-',10),{start:8,end:9});assert.throws(()=>byteRange('bytes=10-',10));assert.throws(()=>byteRange('bytes=1-2,4-5',10));
});
test('bridge state identifies the Video Call Agent service',()=>fixture(async({base})=>{
  const state=await (await fetch(base+'/bridge/state')).json();
  assert.equal(state.service,'video-call-agent');
}));
test('foreign origin cannot start capture or inject audio; helper requires secret',()=>fixture(async({base,post})=>{
  assert.equal((await post('/bridge/capture/start',{windowID:1},{Origin:'https://foreign.example'})).status,403);
  assert.equal((await post('/bridge/capture/start',{windowID:1},{'X-Studio-Token':'wrong'})).status,403);
  assert.equal((await post('/bridge/source',{kind:'idle'},{Origin:'http://127.0.0.1'})).status,200);
  assert.equal((await post('/bridge/ingest/pcm/incoming',Buffer.alloc(8))).status,403);
  assert.equal((await fetch(base+'/bridge/state',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await post('/bridge/frame/incoming',Buffer.from([255,216,255,217]))).status,400);
  assert.equal((await post('/bridge/windows')).status,400);
}));
test('upload and range streaming survive seek; source selection rejects unsafe URLs',()=>fixture(async({base,post})=>{
  assert.equal((await post('/bridge/source',{kind:'url',url:'file:///etc/passwd'})).status,400);
  const payload=Buffer.from('0123456789');assert.equal((await post('/bridge/upload',payload,{'Content-Type':'video/mp4'})).status,200);
  const seek=await fetch(base+'/bridge/file',{headers:{Range:'bytes=3-6'}});assert.equal(seek.status,206);assert.equal(await seek.text(),'3456');
  assert.equal((await fetch(base+'/bridge/file',{headers:{Range:'bytes=20-'}})).status,416);
  const state=await (await fetch(base+'/bridge/state')).json();assert.equal(state.source.kind,'file');assert.equal(state.source.playing,true);
}));
test('JPEG and PCM are relayed to existing subscribers with bounded formats',()=>fixture(async({base,post})=>{
  const controller=new AbortController();
  const audio=await fetch(base+'/bridge/audio/outgoing',{signal:controller.signal});const reader=audio.body.getReader();
  const pcm=Buffer.alloc(80);pcm.writeFloatLE(0.25,0);
  assert.equal((await post('/bridge/pcm/outgoing',pcm)).status,200);
  const event=Buffer.from((await reader.read()).value).toString();const packet=JSON.parse(event.split('data: ')[1]);
  assert.equal(packet.sampleRate,48000);assert.equal(Buffer.from(packet.pcm,'base64').readFloatLE(0),0.25);
  assert.equal((await post('/bridge/pcm/outgoing',Buffer.alloc(7))).status,400);
  const jpeg=Buffer.from([255,216,0,255,217]);assert.equal((await post('/bridge/frame/outgoing',jpeg)).status,200);
  const video=await fetch(base+'/bridge/video/outgoing',{signal:controller.signal});const vreader=video.body.getReader();
  assert.match(Buffer.from((await vreader.read()).value).toString('latin1'),/Content-Type: image\/jpeg/);
  controller.abort();await reader.cancel().catch(()=>{});await vreader.cancel().catch(()=>{});
  const state=await (await fetch(base+'/bridge/state')).json();assert.equal(state.frames.outgoing,1);assert.equal(state.audio.outgoing,1);
}));

test('snapshot refuses missing/stopped capture and cannot expose frames cross-site',()=>fixture(async({base,post})=>{
  assert.equal((await fetch(base+'/bridge/snapshot/incoming')).status,503);
  assert.equal((await fetch(base+'/bridge/snapshot/incoming',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  await post('/bridge/frame/outgoing',Buffer.from([255,216,255,217]));
  assert.equal((await fetch(base+'/bridge/snapshot/incoming')).status,503);
}));

test('native heartbeat or live audio keeps static-video capture alive; stopped or truly stale capture fails',()=>{
 const state={capture:{running:true,lastHeartbeat:99900},lastVideo:1,lastAudio:2};
 assert.equal(captureIsFresh(state,100000),true);
 state.capture.lastHeartbeat=0;state.lastAudio=99900;assert.equal(captureIsFresh(state,100000),true);
 state.lastAudio=2;assert.equal(captureIsFresh(state,100000),false);
 state.capture.lastHeartbeat=99900;state.capture.running=false;assert.equal(captureIsFresh(state,100000),false);
});

test('AI selects a persistent avatar, isolates analysis sessions and never duplicates outgoing audio',()=>fixture(async({base,post})=>{
  await post('/bridge/source',{kind:'url',url:'https://example.com/clip.mp4'});
  assert.equal((await post('/bridge/avatar',{session:'avatar-test-123',action:'start'},{Origin:'https://foreign.example'})).status,403);
  assert.equal((await post('/bridge/avatar',{session:'avatar-test-123',action:'start'})).status,200);
  const state=async()=>await(await fetch(base+'/bridge/state')).json();
  assert.equal((await state()).source.kind,'avatar');
  assert.equal((await post('/bridge/avatar',{session:'avatar-other-123',action:'start'})).status,400);
  const controller=new AbortController();
  const events=await fetch(base+'/bridge/avatar/events',{signal:controller.signal});
  assert.equal(events.status,200);assert.equal(events.headers.get('content-type'),'text/event-stream');
  const reader=events.body.getReader();
  assert.match(Buffer.from((await reader.read()).value).toString(),/"active":true/);
  const pcm=Buffer.alloc(4096*4);pcm.writeFloatLE(0.25,0);
  assert.equal((await post('/bridge/avatar/pcm',{session:'avatar-test-123',sampleRate:48000,pcm:pcm.toString('base64')})).status,200);
  const event=JSON.parse(Buffer.from((await reader.read()).value).toString().split('data: ')[1]);
  assert.equal(event.type,'pcm');assert.equal(event.sampleRate,48000);
  assert.equal(Buffer.from(event.pcm,'base64').readFloatLE(0),0.25);
  assert.equal((await state()).audio.outgoing,0,'mouth analysis must not duplicate the SDK audio output');
  await post('/bridge/avatar',{session:'avatar-other-123',action:'stop'});
  assert.equal((await state()).source.kind,'avatar');
  await post('/bridge/avatar',{session:'avatar-test-123',action:'stop'});
  assert.equal((await state()).source.kind,'avatar','ending analysis must keep the selected image visible');
  assert.equal((await post('/bridge/avatar/pcm',{session:'avatar-test-123',sampleRate:48000,pcm:pcm.toString('base64')})).status,400);
  controller.abort();await reader.cancel().catch(()=>{});
}));

test('heartbeat expiry, explicit analysis stop and service restart keep the image; manual video selection wins recovery',()=>{
  let now=1000;
  return fixture(async({base,post,restart})=>{
    const state=async()=>await(await fetch(base+'/bridge/state')).json();
    await post('/bridge/avatar',{session:'stable-avatar-123',action:'start'});
    now+=15000;
    let s=await state();assert.equal(s.avatar.active,false);assert.equal(s.avatar.reason,'heartbeat-expired');assert.equal(s.source.kind,'avatar');
    assert.equal((await(await post('/bridge/avatar',{session:'stable-avatar-123',action:'ping'})).json()).active,false);
    await post('/bridge/avatar',{session:'stable-avatar-123',action:'start',resume:true});
    await post('/bridge/avatar',{session:'stable-avatar-123',action:'stop'});
    await restart();s=await state();assert.equal(s.source.kind,'avatar');assert.equal(s.avatar.active,false);
    await post('/bridge/source',{kind:'idle'});
    await post('/bridge/avatar',{session:'stable-avatar-123',action:'start',resume:true});
    assert.equal((await state()).source.kind,'idle','analysis recovery must not undo Stop Output');
    await restart();assert.equal((await state()).source.kind,'idle');
    await post('/bridge/source',{kind:'avatar'});await restart();assert.equal((await state()).source.kind,'avatar');
  },{avatarNow:()=>now});
});

test('avatar serves only public rig assets including paths under the Chinese workspace',()=>fixture(async({base})=>{
  const rig=await fetch(base+'/bridge/avatar/rig/index.html');assert.equal(rig.status,200);
  const html=await rig.text();
  assert.match(html,/studio-output\.js/);
  assert.match(html,/<title>2D 数字人 · 程序化绑定<\/title>/);
  assert.match(html,/window\.Avatar\s*=/);
  assert.match(html,/window\.setAvatarExpression\s*=/);
  assert.equal((await fetch(base+'/bridge/avatar/presence-motion.js')).status,200);
  assert.equal((await fetch(base+'/bridge/avatar/studio-output.js')).status,200);
  for (const asset of ['rig/lib/pixi.min.js', 'speech-lipsync.js', 'rig/assets/layers.json', 'rig/assets/face.png']) {
    assert.equal((await fetch(base+'/bridge/avatar/'+asset)).status,200,asset);
  }
  assert.equal((await fetch(base+'/bridge/avatar/character.js')).status,404);
  assert.equal((await fetch(base+'/bridge/avatar/rig/lib/cubism-motionsync.min.js')).status,404);
  assert.equal((await fetch(base+'/bridge/avatar/README.md')).status,404);
  assert.equal((await fetch(base+'/bridge/avatar/presence-motion.js',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
}));

test('saved recording preview supports seek and download and rejects cross-site reads',()=>fixture(async({base,restart,directory})=>{
 const { createRecordings } = await import('../recordings.mjs');
 const r=createRecordings(path.join(directory,'recordings'));const id=r.start('preview-test');r.packet('incoming',Buffer.alloc(480*8));r.packet('input',Buffer.alloc(480*8));r.finish();await restart();
 const state=await(await fetch(base+'/bridge/state')).json();assert.equal(state.recordings.items[0].id,id);
 const url=base+'/bridge/recordings/'+id+'.wav';const preview=await fetch(url);assert.equal(preview.headers.get('content-type'),'audio/wav');assert.equal(Buffer.from(await preview.arrayBuffer()).toString('ascii',0,4),'RIFF');
 const seek=await fetch(url,{headers:{Range:'bytes=0-43'}});assert.equal(seek.status,206);assert.equal((await seek.arrayBuffer()).byteLength,44);
 const download=await fetch(url+'?download=1');assert.match(download.headers.get('content-disposition'),/^attachment/);await download.arrayBuffer();
 assert.equal((await fetch(url,{headers:{Range:'bytes=9999999-'}})).status,416);
 assert.equal((await fetch(url,{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
 assert.equal((await fetch(base+'/bridge/recordings/abcdef.wav')).status,404);
}));

test('call start/reconnect keeps the same avatar source and uses only nondestructive OBS checks',()=>{
 let callChecks=0,manualRepairs=0;
 return fixture(async({base,post})=>{
  await post('/bridge/source',{kind:'avatar'});await new Promise(r=>setImmediate(r));
  assert.equal(manualRepairs,1);
  const source=(await(await fetch(base+'/bridge/state')).json()).source;
  for(const session of ['first-call-avatar','second-call-avatar']){
   await post('/bridge/avatar',{session,action:'start'});await new Promise(r=>setImmediate(r));
   assert.deepEqual((await(await fetch(base+'/bridge/state')).json()).source,source,'call start must preserve renderer URL, revision and start time');
   await post('/bridge/avatar',{session,action:'stop'});
  }
  assert.equal(callChecks,2);assert.equal(manualRepairs,1,'automatic calls must not invoke the manual reload/repair path');
 },{onAvatarStart:()=>{callChecks++;},onOutputPrepare:()=>{manualRepairs++;}});
});

test('recording deletion requires local origin and token, removes preview/download, and survives restart',()=>fixture(async({base,post,restart,directory})=>{
 const {createRecordings}=await import('../recordings.mjs');
 const r=createRecordings(path.join(directory,'recordings'));const id=r.start('delete-test');r.finish();const keep=r.start('keep-test');r.finish();await restart();
 assert.equal((await post('/bridge/recordings/delete',{id},{Origin:'https://foreign.example'})).status,403);
 assert.equal((await post('/bridge/recordings/delete',{id},{'X-Studio-Token':'wrong'})).status,403);
 assert.equal((await post('/bridge/recordings/delete',{id:'../../source'})).status,400);
 assert.equal((await post('/bridge/recordings/delete',{})).status,400);
 const result=await post('/bridge/recordings/delete',{id});assert.equal(result.status,200);assert.equal((await result.json()).deleted,true);
 assert.equal((await(await post('/bridge/recordings/delete',{id})).json()).deleted,false);
 assert.equal((await fetch(`${base}/bridge/recordings/${id}.wav`)).status,404);
 assert.equal((await fetch(`${base}/bridge/recordings/${id}.wav?download=1`)).status,404);
 const remaining=await fetch(`${base}/bridge/recordings/${keep}.wav`);assert.equal(remaining.status,200);await remaining.arrayBuffer();
 await restart();const state=await(await fetch(base+'/bridge/state')).json();assert.deepEqual(state.recordings.items.map(x=>x.id),[keep]);
}));


test('recording is off by default and connected calls cannot record while disabled',()=>fixture(async({base,post})=>{
 const state=await(await fetch(base+'/bridge/state')).json();
 assert.equal(state.recordings.enabled,false);
 const response=await post('/bridge/recordings/start',{callID:'call-1'});
 assert.equal(response.status,200);assert.equal((await response.json()).active,null);
 assert.equal((await post('/bridge/recordings/settings',{enabled:'true'})).status,400);
 assert.equal((await post('/bridge/recordings/settings',{enabled:true},{Origin:'https://foreign.example'})).status,403);
}));

test('header recording setting controls connected calls and resets on restart',()=>fixture(async({base,post,restart})=>{
 await post('/bridge/recordings/start',{callID:'call-1'});
 let status=await(await post('/bridge/recordings/settings',{enabled:true})).json();
 assert.equal(status.enabled,true);assert.equal(status.active.callID,'call-1');
 const firstID=status.active.id;
 await post('/bridge/recordings/start',{callID:'call-1'});
 assert.equal((await(await fetch(base+'/bridge/state')).json()).recordings.active.id,firstID);
 status=await(await post('/bridge/recordings/settings',{enabled:false})).json();
 assert.equal(status.enabled,false);assert.equal(status.active,null);
 await post('/bridge/recordings/stop',{callID:'call-1'});
 status=await(await post('/bridge/recordings/settings',{enabled:true})).json();
 assert.equal(status.active,null);
 await post('/bridge/recordings/start',{callID:'call-2'});
 assert.equal((await(await fetch(base+'/bridge/state')).json()).recordings.active.callID,'call-2');
 await post('/bridge/recordings/stop',{callID:'older-call'});
 assert.equal((await(await fetch(base+'/bridge/state')).json()).recordings.active.callID,'call-2');
 await post('/bridge/recordings/stop',{callID:'call-2'});
 assert.equal((await(await fetch(base+'/bridge/state')).json()).recordings.active,null);
 await restart();
 assert.equal((await(await fetch(base+'/bridge/state')).json()).recordings.enabled,false);
},{helper:process.execPath}));

test('live-canvas broadcasts only visual frames, replays on reconnect and fences switched editors',()=>fixture(async({base,post,restart})=>{
  assert.equal((await post('/bridge/source',{kind:'live-canvas'})).status,200);
  const state=async()=>await(await fetch(base+'/bridge/state')).json();
  const sourceRevision=(await state()).source.revision;
  const controller=new AbortController();
  const response=await fetch(base+'/bridge/live-canvas/events',{signal:controller.signal});
  const reader=response.body.getReader();
  assert.match(Buffer.from((await reader.read()).value).toString(),/data: null/);
  const frame={type:'canvas_stream',action:'write',html:'<svg><text>图解</text></svg>',styles:'text{fill:red}',done:false,secret:'excluded'};
  assert.equal((await post('/bridge/live-canvas',{sourceRevision,frame},{Origin:'https://foreign.example'})).status,403);
  assert.equal((await post('/bridge/live-canvas',{sourceRevision,frame})).status,200);
  const event=JSON.parse(Buffer.from((await reader.read()).value).toString().slice(6));
  assert.equal(event.html,frame.html);assert.equal(event.done,false);assert.equal(event.secret,undefined);
  const replay=await fetch(base+'/bridge/live-canvas/events',{signal:controller.signal});
  const replayReader=replay.body.getReader();
  assert.equal(JSON.parse(Buffer.from((await replayReader.read()).value).toString().slice(6)).html,frame.html);
  assert.equal((await post('/bridge/live-canvas',{sourceRevision,frame:{html:123}})).status,400);
  await post('/bridge/source',{kind:'live-canvas'});
  assert.equal((await post('/bridge/live-canvas',{sourceRevision,frame})).status,409);
  assert.equal((await post('/bridge/live-canvas',{sourceRevision:(await state()).source.revision,frame:null})).status,200);
  controller.abort();await reader.cancel().catch(()=>{});await replayReader.cancel().catch(()=>{});
  await restart();assert.equal((await state()).source.kind,'live-canvas');
  await post('/bridge/source',{kind:'idle'});
  assert.equal((await post('/bridge/live-canvas',{sourceRevision:(await state()).source.revision,frame})).status,409);
  await restart();assert.equal((await state()).source.kind,'idle');
}));
