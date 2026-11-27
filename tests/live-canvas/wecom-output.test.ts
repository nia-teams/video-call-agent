import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createWecomAudioOutput } from '../../app/live-canvas/wecom-output';
function fixture(t: TestContext) {
  let closed = 0, attached = 0;
  const sinks: string[] = [], inputs: string[] = [];
  const destination = {}, analyser = { fftSize: 2048, connect(target: unknown) { assert.equal(target, destination); }, disconnect() {}, getFloatTimeDomainData(data: Float32Array) { data.fill(.25); } };
  const status: any = { defaultInput: ['Node Virtual Mic'], processes: [] };
  class Context {
    destination = destination;
    createAnalyser() { return analyser; }
    async setSinkId(sink: string) { sinks.push(sink); }
    async resume() {} async close() { closed++; }
    createMediaStreamSource(_stream: unknown) { attached++; return { connect(target: unknown) { assert.equal(target, analyser); }, disconnect() {} }; }
  }
  const old = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  Object.defineProperty(globalThis, 'AudioContext', { value: Context, configurable: true });
  t.after(() => { if (old) Object.defineProperty(globalThis, 'AudioContext', old); else Reflect.deleteProperty(globalThis, 'AudioContext'); });
  t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    if (url === '/bridge/state') return Response.json({ csrfToken: 'test' });
    assert.equal(url, '/bridge/audio/prepare'); assert.equal(options?.method, 'POST');
    inputs.push(JSON.parse(options!.body as string).input);
    return Response.json(status);
  });
  return { status, sinks, inputs, stats: () => ({ closed, attached }) };
}
test('prepares Node Virtual Mic, routes received stream to explicit virtual output and measures decoded audio', async t => {
  const f = fixture(t), controller = new AbortController(), levels: any[] = [];
  const output = await createWecomAudioOutput('node-device', 'Node Audio Send (Virtual)', controller.signal, level => levels.push(level));
  t.after(() => output.close());
  assert.deepEqual(f.inputs, ['node']); assert.deepEqual(f.sinks, ['node-device']);
  await output.attach({} as MediaStream);
  await new Promise(resolve => setTimeout(resolve, 230));
  assert.equal(f.stats().attached, 1); assert.equal(levels.at(-1).received, true);
  assert.ok(Math.abs(levels.at(-1).rms - -12.0412) < .01);
  controller.abort(); output.close(); assert.equal(f.stats().closed, 1);
});
test('BlackHole output prepares the matching input instead of Node Virtual Mic', async t => {
  const f = fixture(t); f.status.defaultInput = ['BlackHole 2ch'];
  const output = await createWecomAudioOutput('blackhole-device', 'BlackHole 2ch (Virtual)', new AbortController().signal, () => {});
  output.close(); assert.deepEqual(f.inputs, ['blackhole']); assert.deepEqual(f.sinks, ['blackhole-device']);
});
test('refuses a pinned physical WeCom microphone, invalid devices and late preparation after hangup', async t => {
  const f = fixture(t);
  f.status.processes = [{ bundle: 'com.tencent.WeWorkMac', inputActive: true, input: ['AirPods Pro'] }];
  await assert.rejects(createWecomAudioOutput('node', 'Node Audio Send', new AbortController().signal, () => {}), /企微当前麦克风是 AirPods Pro/);
  await assert.rejects(createWecomAudioOutput('speaker', 'MacBook Pro扬声器', new AbortController().signal, () => {}), /虚拟输出/);
  f.status.processes = []; const controller = new AbortController(); controller.abort();
  await assert.rejects(createWecomAudioOutput('node', 'Node Audio Send', controller.signal, () => {}), { name: 'AbortError' });
  assert.deepEqual(f.sinks, [], 'failed input preparation must never start audio playback');
});
