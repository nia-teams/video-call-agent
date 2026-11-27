import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createCameraSelection} from '../../automation/obs-wecom/camera-selection.mjs';
function fixture(t,timeoutMs=1000){
 const processes=[],messages=[],errors=[];
 const controller=createCameraSelection({timeoutMs,launch:args=>{
  const process=new EventEmitter();process.stdout=new EventEmitter();process.stderr=new EventEmitter();process.args=args;process.kills=[];
  process.kill=signal=>{process.kills.push(signal);process.emit('exit',null,signal);return true;};
  processes.push(process);return process;
 },output:(data,isError)=>messages.push([String(data),isError]),error:message=>errors.push(message)});
 t.after(()=>controller.cancel());return{controller,processes,messages,errors};
}
test('camera progress is streamed before the helper exits',t=>{
 const f=fixture(t);f.controller.start(['--select-camera-window','7']);
 f.processes[0].stderr.emit('data','recognizing menu');f.processes[0].stdout.emit('data','selected OBS');
 assert.deepEqual(f.messages,[['recognizing menu',true],['selected OBS',false]]);
 f.processes[0].emit('exit',0);assert.deepEqual(f.errors,[]);
});
test('a new selection cancels the previous helper without reporting an error',t=>{
 const f=fixture(t);f.controller.start(['one']);f.controller.start(['two']);
 assert.deepEqual(f.processes[0].kills,['SIGTERM']);assert.deepEqual(f.processes[1].args,['two']);assert.deepEqual(f.errors,[]);
});
test('hanging up cancels camera selection and clears its timeout',async t=>{
 const f=fixture(t,10);f.controller.start(['one']);f.controller.cancel();
 await new Promise(r=>setTimeout(r,30));assert.deepEqual(f.processes[0].kills,['SIGTERM']);assert.deepEqual(f.errors,[]);
});
test('a genuine timeout kills the helper and reports the timeout distinctly',async t=>{
 const f=fixture(t,10);f.controller.start(['one']);
 await new Promise(r=>setTimeout(r,30));assert.deepEqual(f.processes[0].kills,['SIGTERM']);assert.equal(f.errors.length,1);assert.match(f.errors[0],/超时/);
});
test('native failures retain streamed diagnostics and report unsuccessful exit',t=>{
 const f=fixture(t);f.controller.start(['one']);f.processes[0].stderr.emit('data','menu unavailable');f.processes[0].emit('exit',1);
 assert.deepEqual(f.messages,[['menu unavailable',true]]);assert.match(f.errors[0],/未完成/);
});
