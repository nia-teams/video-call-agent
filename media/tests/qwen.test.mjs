import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import WebSocket from 'ws';
import sharp from 'sharp';
import { createQwen, configuration, confirmed, SESSION, DEFAULT_MODEL, createDownsampler } from '../qwen.mjs';

const dashscope = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
const env = { DASHSCOPE_API_KEY: 'synthetic-key', QWEN_REALTIME_URL: dashscope };
const ack = (model = DEFAULT_MODEL) => ({ ...structuredClone(SESSION), model });
const turn = () => new Promise(resolve => setImmediate(resolve));
class Provider extends EventEmitter {
  readyState = WebSocket.OPEN; bufferedAmount = 0; sent = []; terminated = false;
  send(raw) { this.sent.push(JSON.parse(raw)); }
  terminate() { this.terminated = true; this.emit('terminated'); }
  event(event) { this.emit('message', Buffer.from(JSON.stringify(event))); }
}
async function fixture(t, options = {}) {
  const providers = [], connections = [], statuses = [];
  const bridge = { authorize: (_req, token) => token === 'csrf-offline', captureReady: () => true, ...options.bridge };
  const qwen = createQwen({ bridge, env: options.env || env, configurationError: options.configurationError, onStatus: status => statuses.push(status), connect: (url, opts) => { connections.push({ url, opts }); const p = new Provider(); providers.push(p); return p; } });
  const server = http.createServer(); server.on('upgrade', qwen.upgrade); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const host = `127.0.0.1:${server.address().port}`, clients = [];
  t.after(async () => { for (const c of clients) c.terminate(); qwen.close(); await new Promise(resolve => server.close(resolve)); });
  async function client(init = { token: 'csrf-offline', source: 'wecom' }) {
    const ws = new WebSocket(`ws://${host}/bridge/qwen`, { origin: `http://${host}` }); clients.push(ws);
    const messages = []; ws.on('message', data => messages.push(JSON.parse(data.toString())));
    await once(ws, 'open'); ws.send(JSON.stringify(init));
    await new Promise(resolve => setTimeout(resolve, 15));
    return { ws, messages };
  }
  return { qwen, providers, connections, client, host, statuses };
}

test('operational session stages expose a fixed reason and counts without provider data', async t => {
  const f = await fixture(t), c = await f.client(), p = f.providers[0];
  p.event({ type: 'session.updated', session: ack() });
  p.event({ type: 'error', error: { message: 'private-provider-payload', api_key: env.DASHSCOPE_API_KEY } });
  await turn();
  assert.deepEqual(f.statuses, [
    { phase: 'connecting' }, { phase: 'ready' },
    { phase: 'failed', reason: 'Qwen provider rejected the session', inputPackets: 0, audioBytes: 0 },
  ]);
  assert.equal(JSON.stringify(f.statuses).includes('private-provider-payload'), false);
  assert.equal(JSON.stringify(f.statuses).includes(env.DASHSCOPE_API_KEY), false);
  assert.equal(c.messages.some(event => event.type === 'error'), true);
});

test('DashScope resolves the default model; custom endpoints keep their path, port and query', () => {
  const defaults = configuration(env);
  assert.equal(defaults.model, DEFAULT_MODEL);
  assert.equal(defaults.url, `${dashscope}?model=${DEFAULT_MODEL}`);
  const custom = 'wss://realtime.example.com:8443/custom/ws?region=test%20region~';
  const chosen = configuration({ ...env, QWEN_REALTIME_URL: custom, QWEN_REALTIME_MODEL: 'tenant/model-v2' });
  assert.equal(chosen.model, 'tenant/model-v2');
  assert.equal(chosen.url, `${custom}&model=tenant%2Fmodel-v2`);
  assert.equal(configuration({ ...env, QWEN_REALTIME_URL: chosen.url }).model, chosen.model);
  assert.equal(configuration({ ...env, QWEN_REALTIME_URL: chosen.url, QWEN_REALTIME_MODEL: chosen.model }).model, chosen.model);
  assert.equal(configuration({ ...env, QWEN_REALTIME_URL: 'wss://[::1]:8443/realtime' }).model, DEFAULT_MODEL);
});

test('model mismatch, duplicates and unsafe endpoint or header values fail closed', () => {
  const invalid = [
    {}, { ...env, DASHSCOPE_API_KEY: '' },
    { ...env, QWEN_REALTIME_URL: `${dashscope}?model=one`, QWEN_REALTIME_MODEL: 'two' },
    ...['ws://example.com', 'https://example.com', 'wss:example.com', 'wss:///example.com',
      'wss://user:pass@example.com', 'wss://@example.com', 'wss://example.com#',
      'wss://example.com/part#fragment', 'wss://-invalid.example.com', 'wss://invalid..example.com',
      'wss://host name.example.com', 'wss://example.com/\r\n', 'wss://example.com\\path',
      `${dashscope}?model=one&%6Dodel=one`, `${dashscope}?model=`, `${dashscope}?model=bad%20model`,
      `${dashscope}?model=bad%00model`, `${dashscope}?model=bad%0d%0a`,
    ].map(QWEN_REALTIME_URL => ({ ...env, QWEN_REALTIME_URL })),
    ...['a b', 'a\rb', 'a\nb', 'a\0b', 'a\x7fb', 'a\u0085b'].map(DASHSCOPE_API_KEY => ({ ...env, DASHSCOPE_API_KEY })),
    ...['a b', 'a\nb', 'a\u0007b', 'a\u202Eb'].map(QWEN_REALTIME_MODEL => ({ ...env, QWEN_REALTIME_MODEL })),
  ];
  for (const value of invalid) assert.throws(() => configuration(value), /^Error: Qwen server configuration invalid$/);
});

test('acknowledgment includes PCM and VAD settings', () => {
  const config = configuration(env);
  assert.equal(confirmed(ack(), config), true);
  const wrong = ack(); wrong.audio.output.format.sample_rate = 16000; assert.equal(confirmed(wrong, config), false);
  const vad = ack(); vad.turn_detection.interrupt_response = true; assert.equal(confirmed(vad, config), false);
});

test('voice defaults only when omitted and accepts safe provider IDs without an enum', () => {
  assert.equal(configuration(env).voice, 'Raymond');
  assert.equal(configuration({ ...env, QWEN_VOICE: 'future_voice-2' }).voice, 'future_voice-2');
  for (const voice of ['', ' Tina', 'Tina\n', 'Ti na', 'Tina/other', null, 42]) {
    assert.throws(() => configuration({ ...env, QWEN_VOICE: voice }), /configuration invalid/);
  }
});

for (const [model, voice, ready] of [['custom-realtime', 'Tina', true], ['custom-realtime', 'Raymond', false], [DEFAULT_MODEL, 'Tina', false]]) {
  test(`configured model and voice require an exact ACK (provider returned ${model}/${voice})`, async t => {
    const f = await fixture(t, { env: { ...env, QWEN_REALTIME_MODEL: 'custom-realtime', QWEN_VOICE: 'Tina' } });
    const c = await f.client(), p = f.providers[0];
    assert.equal(new URL(f.connections[0].url).searchParams.get('model'), 'custom-realtime');
    p.event({ type: 'session.created' });
    const update = p.sent[0];
    const expected = ack('custom-realtime'); expected.audio.output.voice = 'Tina';
    assert.equal(update.type, 'session.update');
    assert.deepEqual({ ...update.session, model: 'custom-realtime' }, expected);
    assert.equal(SESSION.audio.output.voice, 'Raymond');
    const signal = AbortSignal.timeout(2000);
    const received = once(c.ws, ready ? 'message' : 'close', { signal });
    expected.model = model; expected.audio.output.voice = voice;
    p.event({ type: 'session.updated', session: expected });
    await received;
    if (ready) {
      assert.deepEqual(c.messages[0], { type: 'ready' });
      assert.equal(p.terminated, false);
    } else {
      assert.ok(!c.messages.some(event => event.type === 'ready'));
      assert.deepEqual(c.messages.find(event => event.type === 'error'), { type: 'error', message: 'Qwen session configuration not confirmed' });
      assert.equal(p.terminated, true);
    }
  });
}

test('continuous capture downsampling retains phase across native packet boundaries', () => {
  const pcm = Buffer.alloc(48 * 8); for (let i = 0; i < 96; i++) pcm.writeFloatLE(0.5, i * 4);
  const reference = createDownsampler()(pcm), stream = createDownsampler();
  assert.deepEqual(Buffer.concat([stream(pcm.subarray(0, 8)), stream(pcm.subarray(8, 40)), stream(pcm.subarray(40))]), reference);
  assert.equal(reference.length, 32); assert.equal(reference.readInt16LE(0), 16384);
});

test('server authenticates then confirms session before native PCM; direct auth stays upstream', async t => {
  const f = await fixture(t), c = await f.client(), p = f.providers[0];
  assert.equal(f.connections[0].opts.headers.Authorization, `Bearer ${env.DASHSCOPE_API_KEY}`);
  assert.equal(f.connections[0].opts.followRedirects, false);
  f.qwen.incoming(Buffer.alloc(480 * 8)); assert.equal(p.sent.length, 0);
  p.event({ type: 'session.created' }); assert.equal(p.sent[0].type, 'session.update'); assert.deepEqual(p.sent[0].session, SESSION);
  p.event({ type: 'session.updated', session: ack() }); await turn();
  f.qwen.incoming(Buffer.alloc(480 * 8)); assert.equal(p.sent.at(-1).type, 'input_audio_buffer.append'); assert.equal(Buffer.from(p.sent.at(-1).audio, 'base64').length, 320);
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(c.messages[0].type, 'ready');
  assert.ok(!JSON.stringify(c.messages).includes(env.DASHSCOPE_API_KEY));
  // The browser-side close can arrive before the server processes its close
  // event (notably on Node 24/macOS). Observe actual upstream disposal rather
  // than assuming one setImmediate is a backend-cleanup barrier.
  const signal = AbortSignal.timeout(2000);
  const disposed = once(p, 'terminated', { signal });
  const closed = once(c.ws, 'close', { signal });
  c.ws.close(); await Promise.all([closed, disposed]);
  assert.equal(p.terminated, true);
  const next = await f.client();
  assert.equal(f.providers.length, 2, 'backend cleanup must also release session ownership');
  assert.equal(next.messages.some(event => event.type === 'error'), false);
});

function userTurn(provider, id) {
  provider.event({ type: 'input_audio_buffer.speech_started', item_id: id });
  provider.event({ type: 'input_audio_buffer.speech_stopped', item_id: id });
  provider.event({ type: 'input_audio_buffer.committed', item_id: id });
}
const audio = id => ({ type: 'response.audio.delta', response_id: id, delta: Buffer.alloc(4800).toString('base64') });

test('interruption rejects duplicate created and late audio for the old identity even after a new turn', async t => {
  const f = await fixture(t), c = await f.client(), p = f.providers[0];
  p.event({ type: 'session.updated', session: ack() }); userTurn(p, 'input-1');
  p.event({ type: 'response.created', response: { id: 'old' } }); p.event(audio('old'));
  p.event({ type: 'input_audio_buffer.speech_started', item_id: 'input-2' });
  p.event({ type: 'response.created', response: { id: 'old' } }); p.event(audio('old'));
  p.event({ type: 'input_audio_buffer.speech_stopped', item_id: 'input-2' });
  p.event({ type: 'input_audio_buffer.committed', item_id: 'input-2' });
  assert.equal(p.sent.filter(e => e.type === 'response.create').length, 1);
  assert.deepEqual(p.sent.find(e => e.type === 'response.cancel').response_id, 'old');
  p.event({ type: 'response.done', response: { id: 'old', status: 'cancelled' } });
  assert.equal(p.sent.filter(e => e.type === 'response.create').length, 2);
  p.event({ type: 'response.created', response: { id: 'new' } });
  p.event({ type: 'response.created', response: { id: 'old' } }); p.event(audio('old')); p.event(audio('new'));
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual(c.messages.map(e => e.type), ['ready', 'clear', 'audio', 'clear', 'audio']);
});

test('previous response.created delayed until after the next commit cannot claim the new turn', async t => {
  const f = await fixture(t), c = await f.client(), p = f.providers[0];
  p.event({ type: 'session.updated', session: ack() }); userTurn(p, 'input-1');
  // No response identity was known when input-2 interrupted input-1.
  userTurn(p, 'input-2');
  assert.equal(p.sent.filter(e => e.type === 'response.create').length, 1);
  p.event({ type: 'response.created', response: { id: 'delayed-old' } }); p.event(audio('delayed-old'));
  assert.equal(p.sent.at(-1).type, 'response.cancel');
  assert.equal(p.sent.at(-1).response_id, 'delayed-old');
  p.event({ type: 'response.done', response: { id: 'delayed-old', status: 'cancelled' } });
  assert.equal(p.sent.filter(e => e.type === 'response.create').length, 2);
  // A second interruption before the next created event must fence that too.
  userTurn(p, 'input-3');
  p.event({ type: 'response.created', response: { id: 'delayed-second' } }); p.event(audio('delayed-second'));
  p.event({ type: 'response.done', response: { id: 'delayed-second', status: 'cancelled' } });
  p.event({ type: 'response.created', response: { id: 'current' } });
  p.event({ type: 'response.created', response: { id: 'delayed-old' } }); p.event(audio('delayed-old')); p.event(audio('current'));
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual(c.messages.map(e => e.type), ['ready', 'clear', 'clear', 'clear', 'audio']);
});

test('stale speech stop/commit and duplicate input commits cannot create another response', async t => {
  const f = await fixture(t), c = await f.client(), p = f.providers[0];
  p.event({ type: 'session.updated', session: ack() });
  p.event({ type: 'input_audio_buffer.speech_started', item_id: 'new-input' });
  p.event({ type: 'input_audio_buffer.speech_stopped', item_id: 'old-input' });
  p.event({ type: 'input_audio_buffer.committed', item_id: 'old-input' });
  assert.equal(p.sent.length, 0);
  p.event({ type: 'input_audio_buffer.committed', item_id: 'new-input' });
  assert.equal(p.sent.length, 0, 'must wait for speech stop');
  p.event({ type: 'input_audio_buffer.speech_stopped', item_id: 'new-input' });
  p.event({ type: 'response.created', response: { id: 'response-1' } });
  p.event({ type: 'response.done', response: { id: 'response-1', status: 'completed' } });
  p.event({ type: 'input_audio_buffer.committed', item_id: 'new-input' });
  p.event({ type: 'response.created', response: { id: 'response-1' } }); p.event(audio('response-1'));
  assert.equal(p.sent.filter(e => e.type === 'response.create').length, 1);
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(c.messages.filter(e => e.type === 'audio').length, 0);
});

test('authorization, missing config, bad ACK and provider errors fail closed without raw payload leakage', async t => {
  const f = await fixture(t);
  const denied = await f.client({ token: 'wrong', source: 'wecom' }); assert.equal(f.providers.length, 0); assert.equal(denied.messages.find(e => e.type === 'error')?.type, 'error');
  const c = await f.client(), p = f.providers[0];
  p.event({ type: 'session.updated', session: { ...ack(), model: 'wrong' } });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(c.messages.at(-1).type, 'error'); assert.equal(p.terminated, true);
  const next = await f.client(), nextProvider = f.providers[1];
  nextProvider.event({ type: 'error', error: { message: env.DASHSCOPE_API_KEY } });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(!JSON.stringify(next.messages).includes(env.DASHSCOPE_API_KEY));
  const missing = await fixture(t, { env: {} }); const blocked = await missing.client(); assert.equal(missing.providers.length, 0); assert.equal(blocked.messages.find(e => e.type === 'error')?.type, 'error');
});

test('microphone mode never ingests native WeCom audio and concurrent sessions cannot take over', async t => {
  const f = await fixture(t), c = await f.client({ token: 'csrf-offline', source: 'microphone' }), p = f.providers[0];
  p.event({ type: 'session.updated', session: ack() }); await new Promise(resolve => setTimeout(resolve, 10));
  f.qwen.incoming(Buffer.alloc(480 * 8)); assert.equal(p.sent.length, 0);
  c.ws.send(Buffer.alloc(3200)); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(p.sent[0].type, 'input_audio_buffer.append');
  const other = await f.client(); assert.equal(f.providers.length, 1); assert.equal(other.messages.find(e => e.type === 'error')?.type, 'error');
});

test('foreign WebSocket origins cannot create provider sessions', async t => {
  const f = await fixture(t);
  const ws = new WebSocket(`ws://${f.host}/bridge/qwen`, { origin: 'https://foreign.invalid' });
  await new Promise(resolve => { ws.on('error', resolve); ws.on('close', resolve); });
  assert.equal(f.providers.length, 0);
});

test('microphone AudioWorklet produces PCM16k at 48k and 44.1k context rates', () => {
  const script = readFileSync(new URL('../../public/qwen-input.js', import.meta.url), 'utf8');
  for (const rate of [48000, 44100]) {
    let Processor; const packets = [];
    runInNewContext(script, { AudioWorkletProcessor: class { port = { postMessage: data => packets.push(data) }; }, sampleRate: rate, registerProcessor: (_name, value) => { Processor = value; } });
    const p = new Processor();
    for (let n = 0; n < rate; n += 128) p.process([[new Float32Array(Math.min(128, rate - n)).fill(0.5)]]);
    assert.equal(packets.length, 10); assert.equal(packets[0].byteLength, 3200); assert.equal(new DataView(packets[0]).getInt16(0, true), 16384);
  }
});


test('omitted Qwen configuration keeps the local service alive and gives explicit Qwen setup guidance without an upstream request', async t => {
  const loaded = { env: {} };
  const f = await fixture(t, loaded);
  assert.equal(f.providers.length, 0, 'startup must not contact Qwen');
  const c = await f.client();
  assert.equal(f.providers.length, 0);
  assert.match(c.messages.find(e => e.type === 'error')?.message, /Qwen.*未配置.*\.env/);
  const again = await f.client();
  assert.equal(again.messages.find(e => e.type === 'error')?.type, 'error', 'local service remains available');
});

async function waitFor(predicate) {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('offline diagnostic deadline exceeded');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('diagnostics count sent PCM, signal windows and accepted events without content; shutdown clears timers', async t => {
  const f = await fixture(t), c = await f.client(), p = f.providers[0];
  f.qwen.incoming(Buffer.alloc(480 * 8)); // unready PCM is not counted
  p.event({ type: 'session.updated', session: ack() });
  const pcm = Buffer.alloc(480 * 8); for (let i = 0; i < pcm.length; i += 4) pcm.writeFloatLE(0.5, i);
  for (let i = 0; i < 100; i++) f.qwen.incoming(pcm);
  userTurn(p, 'private-item');
  p.event({ type: 'response.created', response: { id: 'private-response' } });
  p.event(audio('stale-response')); p.event(audio('private-response'));
  p.event({ type: 'response.done', response: { id: 'private-response', status: 'completed' } });
  p.event({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'private-transcript' });
  assert.equal(c.messages.filter(e => e.type === 'diagnostics').length, 0, 'no packet-driven diagnostics');
  await waitFor(() => c.messages.some(e => e.type === 'diagnostics'));
  const d = c.messages.find(e => e.type === 'diagnostics');
  assert.deepEqual(d, { type: 'diagnostics', phase: 'ready', inputPackets: 100, inputBytes: 32000, inputRms: 0.5,
    speechStarted: 1, speechStopped: 1, committed: 1, responseRequested: 1, responseCreated: 1, audioBytes: 4800, responseDone: 1, videoFrames: 0, videoBytes: 0, videoSkipped: 0 });
  assert.equal(p.sent.filter(e => e.type === 'input_audio_buffer.append').length, d.inputPackets);
  await waitFor(() => c.messages.filter(e => e.type === 'diagnostics').length === 2);
  assert.equal(c.messages.filter(e => e.type === 'diagnostics')[1].inputRms, 0);
  const wire = JSON.stringify(c.messages);
  for (const secret of [env.DASHSCOPE_API_KEY, env.QWEN_REALTIME_URL, 'private-item', 'private-response', 'private-transcript']) assert.ok(!wire.includes(secret));
  const closed = once(c.ws, 'close'); f.qwen.close(); await closed;
  assert.equal(p.terminated, true);
  const last = c.messages.filter(e => e.type === 'diagnostics').at(-1);
  assert.equal(last.phase, 'closed'); assert.equal(last.inputBytes, 32000);
  const count = c.messages.length;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(c.messages.length, count);
});

test('microphone diagnostics count chunked sends but never backpressured unsent PCM', async t => {
  const f = await fixture(t), c = await f.client({ token: 'csrf-offline', source: 'microphone' }), p = f.providers[0];
  p.event({ type: 'session.updated', session: ack() });
  c.ws.send(Buffer.alloc(16000)); await waitFor(() => p.sent.length === 3);
  p.bufferedAmount = 128001; c.ws.send(Buffer.alloc(3200));
  await waitFor(() => c.messages.some(e => e.type === 'error'));
  const d = c.messages.find(e => e.type === 'diagnostics');
  assert.equal(d.phase, 'failed'); assert.equal(d.inputPackets, 3); assert.equal(d.inputBytes, 16000); assert.equal(d.inputRms, 0);
  assert.equal(p.terminated, true);
});

test('configuration and capture failures report terminal zero counters without upstream calls', async t => {
  for (const options of [{ env: {} }, { bridge: { captureReady: () => false } }]) {
    const f = await fixture(t, options), c = await f.client();
    assert.equal(f.providers.length, 0);
    const d = c.messages.find(e => e.type === 'diagnostics');
    assert.equal(d.phase, 'failed'); assert.equal(d.inputBytes, 0);
    assert.ok(c.messages.some(e => e.type === 'error'));
  }
});

test('shutdown also disposes sockets awaiting initialization without leaving timers alive', async t => {
  const f = await fixture(t);
  const ws = new WebSocket(`ws://${f.host}/bridge/qwen`, { origin: `http://${f.host}` });
  ws.on('error', () => {});
  await once(ws, 'open'); const closed = once(ws, 'close');
  f.qwen.close(); await closed;
  assert.equal(f.providers.length, 0);
});


test('WeCom video waits for confirmed audio, bounds JPEG size and stops with the session', async t => {
  const frame = await sharp({ create: { width: 1280, height: 1000, channels: 3, background: '#ff0000' } }).jpeg().toBuffer();
  const f = await fixture(t, { bridge: { incomingFrame: () => frame } });
  const c = await f.client(), p = f.providers[0];
  await new Promise(resolve => setTimeout(resolve, 1050));
  assert.equal(p.sent.length, 0);
  p.event({ type: 'session.updated', session: ack() });
  await new Promise(resolve => setTimeout(resolve, 1050));
  assert.equal(p.sent.some(e => e.type === 'input_image_buffer.append'), false);
  f.qwen.incoming(Buffer.alloc(480 * 8));
  await waitFor(() => p.sent.some(e => e.type === 'input_image_buffer.append'));
  const sent = p.sent.find(e => e.type === 'input_image_buffer.append');
  assert.ok(sent.image.length <= 256 * 1024);
  const dimensions = await sharp(Buffer.from(sent.image, 'base64')).metadata();
  assert.equal(dimensions.format, 'jpeg');assert.ok(dimensions.width <= 720 && dimensions.height <= 720);
  const closed = once(c.ws, 'close'); c.ws.close(); await closed;
  const count = p.sent.length;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(p.sent.length, count);
});

test('microphone mode never reads or uploads WeCom video', async t => {
  let reads = 0;
  const f = await fixture(t, { bridge: { incomingFrame: () => { reads++; throw new Error('unexpected capture'); } } });
  const c = await f.client({ token: 'csrf-offline', source: 'microphone' }), p = f.providers[0];
  p.event({ type: 'session.updated', session: ack() });
  await waitFor(() => c.messages.some(e => e.type === 'ready'));
  c.ws.send(Buffer.alloc(640));
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(reads, 0);
  assert.equal(p.sent.filter(e => e.type === 'input_image_buffer.append').length, 0);
});
