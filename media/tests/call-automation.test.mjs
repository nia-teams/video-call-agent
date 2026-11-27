import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoCaptureEnabled, cameraSwitchArgs, cameraSwitchForEvent, createCallAutomation, createAudioCallFallback, selectCallWindow } from '../../automation/obs-wecom/call-automation.mjs';
const callWindow={id:7,title:'00:04',width:360,height:640};
test('camera selection only targets an audio-verified connected call with an exact window ID',()=>{
 assert.deepEqual(cameraSwitchForEvent({event:'call_connected',audioVerified:true,windowID:7}),['--select-camera-window','7']);
 for(const event of [{event:'call_ended',audioVerified:true,windowID:7},{event:'call_connected',windowID:7},{event:'call_connected',audioVerified:true,windowID:-1},{event:'call_connected',audioVerified:true,windowID:'7'}])assert.equal(cameraSwitchForEvent(event),null);
});
test('untitled call window requires explicit corroboration by active WeCom input',()=>{
 const window={...callWindow,title:''};
 assert.equal(selectCallWindow([window],7),null);
 assert.equal(selectCallWindow([window],7,true).id,7);
 assert.equal(selectCallWindow([{...window,width:960}],7,true),null);
});
test('audio fallback emits one connected event and debounces call end',async()=>{
 const events=[];let active=true;
 const detector=createAudioCallFallback({probe:async()=>({processes:[{bundle:'com.tencent.WeWorkMac',inputActive:active}]}),windows:async()=>[{...callWindow,title:''}],event:e=>events.push(e)});
 await detector.poll();await detector.poll();
 assert.equal(events.length,1);assert.equal(events[0].audioVerified,true);assert.equal(events[0].windowID,7);
 active=false;await detector.poll();assert.equal(events.length,1);
 active=true;await detector.poll();active=false;await detector.poll();assert.equal(events.length,1);
 await detector.poll();assert.equal(events[1].event,'call_ended');
 active=true;await detector.poll();assert.notEqual(events[2].id,events[0].id);
});
test('audio fallback ignores other app microphones, notification sounds and ambiguous windows',async()=>{
 let processes=[{bundle:'com.google.Chrome',inputActive:true}],windows=[{...callWindow,title:''}];const events=[];
 const detector=createAudioCallFallback({probe:async()=>({processes}),windows:async()=>windows,event:e=>events.push(e)});
 await detector.poll();processes=[{bundle:'com.tencent.WeWorkMac',inputActive:false}];await detector.poll();
 processes[0].inputActive=true;windows.push({...windows[0],id:8});await detector.poll();
 windows=[{...callWindow,title:'视频会议'}];await detector.poll();assert.equal(events.length,0);
});
test('only timer-titled WeCom call windows qualify; ambiguous windows need an exact native ID',()=>{
 assert.equal(selectCallWindow([{id:1,title:'企业微信',width:960,height:800}]),null);
 assert.equal(selectCallWindow([callWindow]).id,7);
 assert.throws(()=>selectCallWindow([callWindow,{...callWindow,id:8}]),/多个/);
 assert.equal(selectCallWindow([callWindow,{...callWindow,id:8}],8).id,8);
});
function fixture(){
 const events=[],commands=[];const current={capture:{running:false,windowID:null,error:''},lastVideo:0};
 const controller=createCallAutomation({enabled:true,state:async()=>current,changed:event=>events.push(event),sleep:async()=>{},command:async(path,payload)=>{commands.push({path,payload});if(path==='windows')return[callWindow];if(path==='capture/start'){current.capture={running:true,windowID:payload.windowID,error:''};current.lastVideo=100;}if(path==='capture/stop')current.capture.running=false;return{};}});
 return {controller,current,events,commands};
}
test('connected call automatically lists and captures once, then ends only its own capture',async()=>{
 const f=fixture();
 await f.controller.event({event:'call_connected',id:'call-1'});assert.equal(f.events.at(-1).phase,'ready');assert.equal(f.events.at(-1).windowID,7);
 await f.controller.event({event:'call_connected',id:'call-1'});assert.equal(f.commands.filter(c=>c.path==='capture/start').length,1);
 await f.controller.event({event:'call_ended',id:'call-1'});assert.equal(f.events.at(-1).phase,'ended');assert.equal(f.commands.at(-1).path,'capture/stop');
});
test('ending during window discovery cancels late automatic capture',async()=>{
 let resolve;const commands=[];const controller=createCallAutomation({enabled:true,state:async()=>({capture:{running:false,windowID:null}}),changed(){},command:async path=>{commands.push(path);if(path==='windows')return new Promise(r=>{resolve=r;});return{};}});
 const pending=controller.event({event:'call_connected',id:'a'});while(!resolve) await new Promise(r=>setImmediate(r));const ending=controller.event({event:'call_ended',id:'a'});resolve([callWindow]);await pending;await ending;assert.deepEqual(commands,['recordings/start','windows','recordings/stop']);
});
test('ending a call preserves a different window manually selected by the user',async()=>{
 const f=fixture();await f.controller.event({event:'call_connected',id:'a'});f.current.capture.windowID=99;await f.controller.event({event:'call_ended',id:'a'});assert.equal(f.commands.some(c=>c.path==='capture/stop'),false);
});

test('call events start and stop recording exactly once with the call ID',async()=>{
 const f=fixture();await f.controller.event({event:'call_connected',id:'voice-1'});await f.controller.event({event:'call_connected',id:'voice-1'});
 await f.controller.event({event:'call_ended',id:'voice-1'});
 assert.deepEqual(f.commands.filter(c=>c.path.startsWith('recordings/')),[{path:'recordings/start',payload:{callID:'voice-1'}},{path:'recordings/stop',payload:{callID:'voice-1'}}]);
});
test('recording stop failure cannot prevent hanging up capture resources',async()=>{
 const commands=[];const controller=createCallAutomation({enabled:true,state:async()=>({capture:{running:true,windowID:7},lastVideo:1}),changed(){},command:async(path)=>{commands.push(path);if(path==='windows')return[callWindow];if(path==='recordings/stop')throw new Error('Not found');return{};}});
 await controller.event({event:'call_connected',id:'cleanup'});await controller.event({event:'call_ended',id:'cleanup'});
 assert.equal(commands.at(-1),'capture/stop');
});

test('unconfigured standalone controller does not capture or record an answered call', async () => {
  const controller = createCallAutomation({
    state: async () => { throw new Error('must not inspect devices'); },
    command: async () => { throw new Error('must not capture or record'); },
    changed() { throw new Error('must not publish automation state'); },
  });
  await controller.event({ event: 'call_connected', id: 'manual-call' });
  await controller.event({ event: 'call_ended', id: 'manual-call' });
  controller.close();
});

test('platform enables automatic answering by default and allows an explicit opt-out', () => {
  assert.deepEqual(cameraSwitchArgs({}), ['--watch', '--wecom-only', '--auto-answer']);
  assert.deepEqual(cameraSwitchArgs({STUDIO_AUTO_ANSWER:'0'}), ['--watch', '--wecom-only']);
  assert.deepEqual(cameraSwitchArgs({STUDIO_AUTO_CAPTURE:'0'}), ['--watch', '--wecom-only', '--auto-answer']);
});

test('platform captures answered calls by default, with explicit disable taking precedence', () => {
  assert.equal(autoCaptureEnabled({}), true);
  assert.equal(autoCaptureEnabled({STUDIO_AUTO_CAPTURE:'1'}), true);
  assert.equal(autoCaptureEnabled({STUDIO_AUTO_CAPTURE:'0'}), false);
  assert.equal(autoCaptureEnabled({STUDIO_AUTO_ANSWER:'0'}), true, 'manually answered calls can still relay');
});
