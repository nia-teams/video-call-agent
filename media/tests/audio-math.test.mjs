import {test} from 'node:test';
import assert from 'node:assert/strict';
import {measure} from '../../app/studio/audio-math.mjs';
test('silence stays silent even with many samples',()=>{const m=measure(new Float32Array(48000));assert.equal(m.rms,-96);assert.equal(m.signal,false);});
test('known amplitude maps to dBFS and clipping is distinguished',()=>{const m=measure(new Float32Array([0.5,-0.5]));assert.ok(Math.abs(m.rms+6.0206)<0.001);assert.equal(m.signal,true);assert.equal(m.clipped,false);assert.equal(measure([1,-1]).clipped,true);});
test('bad sample values do not turn a meter into NaN',()=>{const m=measure([NaN,Infinity,-Infinity,0]);assert.equal(m.rms,-96);assert.equal(m.signal,false);});
