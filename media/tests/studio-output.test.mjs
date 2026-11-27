import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const script=readFileSync(new URL('../avatar-assets/studio-output.js',import.meta.url),'utf8');
test('hidden live renderer processes PCM, recovers from lost reset and closes its mouth after speech',()=>{
 let now=1000,tick,stream,pushed=0;const stage={dataset:{}};
 const her={params:{O:0},presenceState:'idle',setMotionStyle(){},resetAudio(){this.params.O=0;},setPresenceState(s){this.presenceState=s;},pushAudioSamples(){pushed++;this.params.O=12;}};
 class Events{constructor(){stream=this;}close(){}}
 runInNewContext(script,{URLSearchParams,location:{search:'?studio=1'},performance:{now:()=>now},window:{HeR:her,addEventListener(){}},document:{hidden:true,getElementById:()=>stage},EventSource:Events,Uint8Array,Float32Array,Math,JSON,atob:s=>Buffer.from(s,'base64').toString('binary'),setInterval:fn=>{tick=fn;},setTimeout(){},clearInterval(){},clearTimeout(){}});
 const pcm=Buffer.alloc(1024*4);for(let i=0;i<1024;i++)pcm.writeFloatLE(.2,i*4);
 stream.onerror();stream.onmessage({data:JSON.stringify({type:'pcm',pcm:pcm.toString('base64'),sampleRate:16000})});
 assert.equal(pushed,1);assert.equal(her.presenceState,'speaking');tick();assert.equal(JSON.parse(stage.dataset.lipState).mouth,12);
 now+=300;tick();assert.equal(her.presenceState,'listening');assert.equal(her.params.O,0);
 stream.onmessage({data:JSON.stringify({type:'reset',active:false})});assert.equal(her.presenceState,'idle');
});
