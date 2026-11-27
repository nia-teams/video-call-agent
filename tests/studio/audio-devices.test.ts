import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExplicitDevice, virtualInput } from '../../app/studio/audio-devices';
test('virtual routing never binds to mutable default/communications aliases',()=>{
 const devices=[{kind:'audioinput',deviceId:'default',label:'默认 - Node Virtual Mic'},{kind:'audioinput',deviceId:'node-mic-id',label:'Node Virtual Mic'},{kind:'audiooutput',deviceId:'communications',label:'Node Audio Send'},{kind:'audiooutput',deviceId:'node-send-id',label:'Node Audio Send'}] as MediaDeviceInfo[];
 assert.deepEqual(devices.filter(isExplicitDevice).map(d=>d.deviceId),['node-mic-id','node-send-id']);
 assert.equal(virtualInput(devices)?.deviceId,'node-mic-id');assert.equal(virtualInput([devices[0]]),undefined);
});
