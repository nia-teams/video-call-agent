import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const context = {};
runInNewContext(readFileSync(new URL('../avatar-assets/speech-lipsync.js', import.meta.url), 'utf8'), context);
const { SpeechLipSync } = context;
function tone(rate, duration, hz, amplitude = .2) {
  return Float32Array.from({ length: Math.round(rate * duration) }, (_, i) => amplitude * Math.sin(2 * Math.PI * hz * i / rate));
}
function speak(engine, hz = 650, amplitude = .2, frames = 20) {
  let shape;
  for (let i = 0; i < frames; i++) {
    engine.push(tone(engine.sampleRate, .02, hz, amplitude));
    shape = engine.step(.02);
  }
  return shape;
}
test('silence, low noise and DC offsets leave a neutral closed mouth', () => {
  for (const samples of [new Float32Array(2400), new Float32Array(2400).fill(.4), tone(24000, .1, 650, .003)]) {
    const engine = new SpeechLipSync(); engine.push(samples);
    const shape = engine.step(.1);
    assert.equal(shape.open, 0); assert.equal(shape.width, 1); assert.equal(shape.round, 0);
  }
});
test('audio energy controls opening and spectral balance changes articulation', () => {
  const quiet = speak(new SpeechLipSync(), 900, .03);
  const loud = speak(new SpeechLipSync(), 900, .3);
  assert.ok(loud.open > quiet.open + .2);
  const low = speak(new SpeechLipSync(), 400);
  const high = speak(new SpeechLipSync(), 2100);
  assert.ok(low.round > high.round + .5);
  assert.ok(high.width > low.width + .3);
});
test('supported relay rates produce finite, bounded, comparable articulation', () => {
  const shapes = [];
  for (const rate of [16000, 22050, 24000, 32000, 44100, 48000, 96000]) {
    const shape = speak(new SpeechLipSync(rate)); shapes.push(shape);
    for (const value of Object.values(shape)) assert.ok(Number.isFinite(value));
    assert.ok(shape.open > .1 && shape.open <= 1);
    assert.ok(shape.width >= .7 && shape.width <= 1.26);
    assert.ok(shape.round >= 0 && shape.round <= 1);
  }
  assert.ok(Math.max(...shapes.map(s => s.open)) - Math.min(...shapes.map(s => s.open)) < .02);
});
test('packet boundaries and render rates do not change the analyzed audio timeline', () => {
  const a = new SpeechLipSync(), b = new SpeechLipSync();
  const samples = tone(24000, .12, 1200);
  a.push(samples);
  for (let i = 0; i < samples.length; i += 113) b.push(samples.subarray(i, i + 113));
  let x, y;
  for (let i = 0; i < 12; i++) x = a.step(.01);
  for (let i = 0; i < 4; i++) y = b.step(.03);
  for (const key of Object.keys(x)) assert.ok(Math.abs(x[key] - y[key]) < 1e-10, key);
});
test('starvation drains partial audio frames and closes the mouth without new packets', () => {
  const engine = new SpeechLipSync();
  assert.ok(speak(engine).open > .1);
  engine.push(tone(24000, .007, 650));
  let shape;
  for (let i = 0; i < 36; i++) shape = engine.step(1 / 60);
  assert.equal(shape.open, 0); assert.equal(shape.round, 0);
  assert.ok(Math.abs(shape.width - 1) < .001);
  assert.equal(engine.queuedSamples, 0);
});
test('reset and sample-rate changes discard speech from the previous stream', () => {
  const engine = new SpeechLipSync(); speak(engine); engine.push(tone(24000, .1, 650));
  engine.reset(); assert.equal(engine.queuedSamples, 0); assert.equal(engine.step(.02).open, 0);
  speak(engine); engine.push(new Float32Array(480), 48000);
  assert.equal(engine.sampleRate, 48000); assert.equal(engine.step(.02).open, 0);
  assert.throws(() => engine.push(new Float32Array(1), NaN), /sample rate/);
});
test('malformed PCM is sanitized and overload retains only the newest bounded audio', () => {
  const engine = new SpeechLipSync();
  engine.push(new Float32Array(24000).fill(.2));
  engine.push(new Float32Array(24000));
  assert.equal(engine.queuedSamples, 4320);
  assert.equal(engine.step(.1).open, 0);
  engine.push(Float32Array.from([NaN, Infinity, -Infinity, 9, -9]));
  for (let i = 0; i < 10; i++) for (const value of Object.values(engine.step(.02))) assert.ok(Number.isFinite(value));
  assert.equal(engine.step(Infinity).open, engine.open);
});
