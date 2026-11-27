import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createWecomAudioInput } from '../../app/live-canvas/wecom-audio';
function fixture(t: TestContext) {
  let stopped = 0, contextsClosed = 0, eventsClosed = 0, scheduled = 0;
  const destination = { stream: { getTracks: () => [{ kind: 'audio', stop() { stopped++; } }] } };
  class Context {
    currentTime = 0;
    createMediaStreamDestination() { return destination; }
    async resume() {} async close() { contextsClosed++; }
    createBuffer() { return { duration: .1, copyToChannel() {} }; }
    createBufferSource() { return { buffer: null, connect(target: unknown) { assert.equal(target, destination); }, disconnect() {}, start() { scheduled++; }, stop() {} }; }
  }
  let events: { onmessage?: (e: { data: string }) => void; onerror?: () => void };
  class Events {
    onmessage?: (e: { data: string }) => void;
    onerror?: () => void;
    constructor(url: string) { assert.equal(url, '/bridge/audio/incoming'); events = this; }
    close() { eventsClosed++; }
  }
  for (const [name, value] of Object.entries({ AudioContext: Context, EventSource: Events })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => { if (old) Object.defineProperty(globalThis, name, old); else Reflect.deleteProperty(globalThis, name); });
  }
  const failures: string[] = [], controller = new AbortController();
  return { controller, failures, stats: () => ({ stopped, contextsClosed, eventsClosed, scheduled }), events: () => events!, open: () => createWecomAudioInput(message => failures.push(message), controller.signal) };
}
test('WeCom audio input bounds queued PCM and releases resources on hangup, without connecting speakers', async t => {
  const f = fixture(t); const input = await f.open();
  assert.deepEqual(input.stream.getTracks().map(t => t.kind), ['audio']);
  const data = JSON.stringify({ pcm: Buffer.alloc(38400).toString('base64'), sampleRate: 48000, channels: 2 });
  for (let i = 0; i < 20; i++) f.events().onmessage!({ data });
  assert.equal(f.stats().scheduled, 4);
  f.controller.abort(); input.close();
  assert.deepEqual(f.stats(), { stopped: 1, contextsClosed: 1, eventsClosed: 1, scheduled: 4 });
});
test('WeCom audio fails closed on transport loss and malformed PCM', async t => {
  const f = fixture(t); const input = await f.open();
  f.events().onmessage!({ data: '{"pcm":123}' });
  assert.equal(f.failures.length, 1); input.close(); assert.equal(f.stats().contextsClosed, 1);
  const second = await f.open(); f.events().onerror!();
  assert.equal(f.failures.length, 2); second.close(); assert.equal(f.stats().eventsClosed, 2);
});
test('WeCom audio cancels an already-ended call before subscribing', async t => {
  const f = fixture(t); f.controller.abort(); await assert.rejects(f.open(), { name: 'AbortError' });
  assert.equal(f.stats().contextsClosed, 1); assert.equal(f.stats().eventsClosed, 0);
});
