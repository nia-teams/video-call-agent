import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { acquireProviderSession } from '../../lib/studio/provider-session';
const Renderer = require('react-test-renderer');
const { act } = Renderer;

function browser(t: any) {
  let held = false;
  const devices = Object.assign(new EventTarget(), { enumerateDevices: async () => [] });
  const navigator = { mediaDevices: devices, locks: { request: async (_name: string, _options: object, callback: (lock: object | null) => Promise<void>) => {
    await Promise.resolve();
    if (held) return callback(null);
    held = true;
    try { return await callback({ name: 'wecom-studio-ai-provider' }); } finally { held = false; }
  } } };
  const window = Object.assign(new EventTarget(), { setInterval, clearInterval });
  const document = Object.assign(new EventTarget(), { hidden: false });
  for (const [key, value] of Object.entries({ navigator, window, document, IS_REACT_ACT_ENVIRONMENT: true })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
  }
  return { navigator, window, document, AbortController, location: { origin: 'http://127.0.0.1:3070' } };
}

test('actual provider lease excludes a second tab and releases only when its owner closes', async t => {
  browser(t);
  const release = await acquireProviderSession();
  await assert.rejects(acquireProviderSession(), /另一个/);
  release(); release(); await new Promise(resolve => setImmediate(resolve));
  const next = await acquireProviderSession(); next();
});

test('unavailable Web Locks and cancelled acquisition fail closed', async t => {
  const b = browser(t), controller = new AbortController(); controller.abort();
  await assert.rejects(acquireProviderSession(controller.signal), { name: 'AbortError' });
  Object.assign(b.navigator, { locks: undefined });
  await assert.rejects(acquireProviderSession(), /不支持/);
});

test('actual Qwen panel disconnects on unmount and retains ownership until its WebSocket closes', async t => {
  const b = browser(t); let socket: FakeSocket | undefined, contextClosed = 0, mouthClosed = 0;
  class FakeSocket extends EventTarget {
    static OPEN = 1; readyState = 1; bufferedAmount = 0; closing = false;
    constructor(_url: string) { super(); socket = this; }
    close() { this.closing = true; }
    send() {}
  }
  class Context {
    createAnalyser() { return { fftSize: 2048, connect() {}, disconnect() {} }; }
    state = 'running'; currentTime = 0;
    async setSinkId() {} async resume() {} async close() { contextClosed++; }
  }
  Object.assign(b.navigator.mediaDevices, {
    async getUserMedia() { return { getTracks: () => [{ stop() {} }] }; },
    async enumerateDevices() { return [{ kind: 'audiooutput', deviceId: 'virtual', label: 'Node Audio Send (Virtual)' }]; },
  });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ csrfToken: 'test-token', capture: { running: true }, avatar: { active: false } }));
  const filename = new URL('../../app/qwen/panel.tsx', import.meta.url), localRequire = createRequire(filename);
  const module = { exports: {} as any };
  runInNewContext(transformSync(readFileSync(filename, 'utf8'), { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code, {
    ...b, module, exports: module.exports, AudioContext: Context, WebSocket: FakeSocket, fetch: globalThis.fetch,
    setTimeout, clearTimeout, setInterval, clearInterval,
    require: (id: string) => (/\.(css|scss)$/.test(id)) ? {} : id.endsWith('/levels') ? { AnalyserMeter: () => null, IncomingMeter: () => null, BlackHoleMeter: () => null } : id.endsWith('/avatar-publisher') ? { createAvatarPublisher: () => ({ async start() { return true; }, async clear() { return true; }, close() { mouthClosed++; } }) } : localRequire(id),
  });
  let tree: any;
  await act(async () => { tree = Renderer.create(React.createElement(module.exports.default)); });
  const button = (label: string) => tree.root.findAllByType('button').find((n: any) => (n.props['aria-label'] === label || n.children.join('') === label));
  await act(async () => button('授权并刷新音频设备').props.onClick());
  await act(async () => tree.root.findByProps({ 'aria-label': 'Qwen 虚拟话筒输出' }).props.onChange({ target: { value: 'virtual' } }));
  await act(async () => { button('连接 Qwen').props.onClick(); await new Promise(resolve => setImmediate(resolve)); });
  assert.ok(socket); await assert.rejects(acquireProviderSession(), /另一个/);
  await act(async () => tree.unmount());
  assert.equal(socket!.closing, true); assert.equal(contextClosed, 1); assert.equal(mouthClosed, 1);
  await assert.rejects(acquireProviderSession(), /另一个/, 'closing transport still owns the lock');
  socket!.dispatchEvent(new Event('close')); await new Promise(resolve => setImmediate(resolve));
  const release = await acquireProviderSession(); release();
});

for (const failure of ['http-error', 'inactive-ack'] as const) {
  test(`Qwen clear ${failure} stops queued audio and closes its connection even when warnings are suppressed`, async t => {
    const { createAvatarPublisher } = await import('../../lib/studio/avatar-publisher');
    const b = browser(t);
    let socket: any, contextClosed = 0, audioStarted = 0, audioStopped = 0, clearRequests = 0;
    const scheduled = new Map<number, () => void>(); let timerID = 0;
    const intervals = new Map<number, () => void>();
    let failClear!: () => void;
    class FakeSocket extends EventTarget {
      static OPEN = 1; readyState = 1; bufferedAmount = 0; closing = false;
      constructor(_url: string) { super(); socket = this; }
      close() { this.closing = true; }
      send() {}
    }
    class Context {
    createAnalyser() { return { fftSize: 2048, connect() {}, disconnect() {} }; }
      state = 'running'; currentTime = 0; destination = {};
      async setSinkId() {} async resume() {} async close() { contextClosed++; this.state = 'closed'; }
      createBuffer() { return { copyToChannel() {}, duration: .1 }; }
      createBufferSource() { return { connect() {}, disconnect() {}, start() { audioStarted++; }, stop() { audioStopped++; } }; }
    }
    Object.assign(b.navigator.mediaDevices, {
      async getUserMedia() { return { getTracks: () => [{ stop() {} }] }; },
      async enumerateDevices() { return [{ kind: 'audiooutput', deviceId: 'virtual', label: 'Node Audio Send (Virtual)' }]; },
    });
    t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
      if (url === '/bridge/state') return Response.json({ csrfToken: 'test-token', capture: { running: true }, avatar: { active: false } });
      const input = JSON.parse(String(options?.body));
      if (input.action === 'clear') {
        clearRequests++;
        await new Promise<void>(resolve => { failClear = resolve; });
        return failure === 'http-error' ? new Response('', { status: 500 }) : Response.json({ active: false });
      }
      return Response.json({ active: true });
    });
    const filename = new URL('../../app/qwen/panel.tsx', import.meta.url), localRequire = createRequire(filename);
    const module = { exports: {} as any };
    runInNewContext(transformSync(readFileSync(filename, 'utf8'), { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code, {
      ...b, module, exports: module.exports, AudioContext: Context, WebSocket: FakeSocket, fetch: globalThis.fetch, atob,
      setInterval: (fn: () => void, ms: number) => { assert.equal(ms, 1000); intervals.set(++timerID, fn); return timerID; }, clearInterval: (id: number) => intervals.delete(id),
      setTimeout: (fn: () => void) => { scheduled.set(++timerID, fn); return timerID; }, clearTimeout: (id: number) => scheduled.delete(id),
      // Use the real publisher; suppress its advisory callback to prove clear's
      // result closes Qwen independently of the warning latch/callback.
      require: (id: string) => (/\.(css|scss)$/.test(id)) ? {} : id.endsWith('/levels') ? { AnalyserMeter: () => null, IncomingMeter: () => null, BlackHoleMeter: () => null } : id.endsWith('/avatar-publisher') ? { createAvatarPublisher: (_warn: unknown, provider: string) => createAvatarPublisher(() => {}, provider) } : localRequire(id),
    });
    let tree: any, disposed = false;
    await act(async () => { tree = Renderer.create(React.createElement(module.exports.default)); });
    t.after(async () => { if (!disposed) { await act(async () => tree.unmount()); socket?.dispatchEvent(new Event('close')); } });
    const button = (label: string) => tree.root.findAllByType('button').find((n: any) => (n.props['aria-label'] === label || n.children.join('') === label));
    await act(async () => button('授权并刷新音频设备').props.onClick());
    await act(async () => tree.root.findByProps({ 'aria-label': 'Qwen 虚拟话筒输出' }).props.onChange({ target: { value: 'virtual' } }));
    await act(async () => { button('连接 Qwen').props.onClick(); await new Promise(resolve => setImmediate(resolve)); });
    const event = (value: object) => socket.onmessage({ data: JSON.stringify(value) });
    const audio = { type: 'audio', pcm: Buffer.alloc(4800).toString('base64') };
    assert.equal(intervals.size, 1);
    await act(async () => { event({ type: 'ready' }); event(audio); });
    const text = () => JSON.stringify(tree.toJSON());
    assert.ok(text().includes('客户端虚拟话筒已排程：'));
    assert.ok(!text().includes('4800'), 'audio packet does not drive diagnostic state setters');
    await act(async () => { for (const tick of intervals.values()) tick(); });
    assert.ok(text().includes('4800'), 'count only after AudioBufferSource.start succeeded and diagnostic tick');
    await act(async () => event({ type: 'diagnostics', phase: 'ready', inputPackets: 7, inputBytes: 22400, inputRms: .25,
      speechStarted: 1, speechStopped: 1, committed: 1, responseRequested: 1, responseCreated: 1, audioBytes: 4800, responseDone: 0 }));
    assert.ok(text().includes('0.2500')); assert.ok(text().includes('22400'));
    assert.ok(text().includes('不是本机扬声器'));

    await act(async () => { event({ type: 'clear' }); event(audio); await new Promise(resolve => setImmediate(resolve)); });
    assert.equal(clearRequests, 1); assert.equal(audioStarted, 2);
    await act(async () => { failClear(); await new Promise(resolve => setImmediate(resolve)); });
    assert.equal(intervals.size, 0, 'failure stops diagnostic polling');
    assert.equal(socket.closing, true); assert.equal(contextClosed, 1); assert.equal(audioStopped, 2);
    assert.equal(scheduled.size, 0, 'failure must cancel new-turn mouth timers and stop its scheduled audio');
    assert.match(tree.root.findByProps({ role: 'alert' }).children.join(''), /清空未确认.*停止 Qwen/);
    await act(async () => event(audio)); assert.equal(audioStarted, 2, 'late audio must not resume a failed call');
    await assert.rejects(acquireProviderSession(), /另一个/, 'ownership persists until transport closes');
    socket.dispatchEvent(new Event('close')); await new Promise(resolve => setImmediate(resolve));
    const release = await acquireProviderSession(); release();
    await act(async () => tree.unmount()); disposed = true;
  });
}

for (const scenario of ['physical', 'missing', 'virtual', 'overconstrained', 'late', 'no-candidates'] as const) {
  test(`Qwen explicit local microphone: ${scenario}`, async t => {
    const b = browser(t);
    const calls: any[] = []; let stopped = 0, permissionStopped = 0, contextsClosed = 0;
    let resolveCapture!: (stream: any) => void, resolveState!: (response: Response) => void;
    const track = { label: 'USB 耳机麦克风', muted: false, enabled: true, readyState: 'live',
      getSettings: () => ({ sampleRate: 48000, channelCount: 1, deviceId: 'never-show-settings-id', groupId: 'never-show-group-id' }),
      stop() { stopped++; this.readyState = 'ended'; }, onended: null, onmute: null, onunmute: null };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    let devices = [
      { kind: 'audioinput', deviceId: 'default', label: '默认 - Node Virtual Mic' },
      { kind: 'audioinput', deviceId: 'communications', label: '通信 - USB 耳机麦克风' },
      { kind: 'audioinput', deviceId: 'loop', label: 'Node Virtual Mic' },
      { kind: 'audioinput', deviceId: 'blackhole', label: 'BlackHole 2ch' },
      { kind: 'audioinput', deviceId: 'usb', label: 'USB 耳机麦克风' },
      { kind: 'audioinput', deviceId: 'builtin', label: 'MacBook Pro 麦克风' },
      { kind: 'audioinput', deviceId: 'unlabeled', label: '' },
      { kind: 'audiooutput', deviceId: 'virtual', label: 'Node Audio Send' },
      { kind: 'audiooutput', deviceId: 'speakers', label: 'MacBook Pro 扬声器' },
    ];
    Object.assign(b.navigator.mediaDevices, {
      async enumerateDevices() { return devices; },
      async getUserMedia(constraints: any) {
        calls.push(constraints);
        if (constraints.audio === true) return { getTracks: () => [{ stop() { permissionStopped++; } }] };
        if (scenario === 'overconstrained') throw Object.assign(new Error('device vanished'), { name: 'OverconstrainedError' });
        if (scenario === 'late') return new Promise(resolve => { resolveCapture = resolve; });
        return stream;
      },
    });
    class Context {
    createAnalyser() { return { fftSize: 2048, connect() {}, disconnect() {} }; }
      currentTime = 0; destination = {}; audioWorklet = { async addModule() {} };
      async setSinkId() {} async resume() {} async close() { contextsClosed++; }
      createMediaStreamSource() { return { connect() {} }; }
    }
    class Worklet { port = {}; connect() {} disconnect() {} }
    const filename = new URL('../../app/qwen/panel.tsx', import.meta.url), localRequire = createRequire(filename);
    const module = { exports: {} as any };
    runInNewContext(transformSync(readFileSync(filename, 'utf8'), { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code, {
      ...b, module, exports: module.exports, AudioContext: Context, AudioWorkletNode: Worklet,
      fetch: () => new Promise<Response>(resolve => { resolveState = resolve; }),
      setTimeout, clearTimeout, setInterval, clearInterval,
      require: (id: string) => (/\.(css|scss)$/.test(id)) ? {} : id.endsWith('/levels') ? { AnalyserMeter: () => null, IncomingMeter: () => null, BlackHoleMeter: () => null } : localRequire(id),
    });
    let tree: any;
    await act(async () => { tree = Renderer.create(React.createElement(module.exports.default)); });
    t.after(async () => { await act(async () => tree.unmount()); });
    const button = (label: string) => tree.root.findAllByType('button').find((n: any) => (n.props['aria-label'] === label || n.children.join('') === label));
    const change = async (label: string, value: string) => act(async () => tree.root.findByProps({ 'aria-label': label }).props.onChange({ target: { value } }));
    assert.equal(calls.length, 0, 'mount does not capture or connect');
    await change('Qwen 音频输入', 'microphone');
    await act(async () => button('授权并刷新音频设备').props.onClick());
    const options = tree.root.findByProps({ 'aria-label': 'Qwen 本机麦克风' }).findAllByType('option');
    assert.deepEqual(options.map((o: any) => o.props.value), ['', 'usb', 'builtin']);
    assert.equal(permissionStopped, 1);
    assert.equal(calls.length, 1, 'refresh does not start a session');
    if (scenario === 'no-candidates') {
      devices = devices.filter(d => !['usb', 'builtin'].includes(d.deviceId));
      await act(async () => button('授权并刷新音频设备').props.onClick());
      assert.deepEqual(tree.root.findByProps({ 'aria-label': 'Qwen 本机麦克风' }).findAllByType('option').map((o: any) => o.props.value), ['']);
      assert.match(tree.root.findByProps({ role: 'alert' }).children.join(''), /未发现可选实体麦克风/);
      assert.equal(calls.length, 2); assert.equal(permissionStopped, 2); assert.equal(contextsClosed, 0);
      return;
    }
    await change('Qwen 虚拟话筒输出', 'virtual');
    await act(async () => { button('连接 Qwen').props.onClick(); await new Promise(resolve => setImmediate(resolve)); });
    assert.equal(calls.length, 1, 'no default capture without selection');
    assert.match(tree.root.findByProps({ role: 'alert' }).children.join(''), /明确选择/);
    await change('Qwen 本机麦克风', scenario === 'virtual' ? 'loop' : 'usb');
    if (scenario === 'missing') devices = devices.filter(d => d.deviceId !== 'usb');
    await act(async () => { button('连接 Qwen').props.onClick(); await new Promise(resolve => setImmediate(resolve)); });
    if (scenario === 'missing' || scenario === 'virtual') {
      assert.equal(calls.length, 1, 'invalid selection must not capture or fall back');
      assert.match(tree.root.findByProps({ role: 'alert' }).children.join(''), scenario === 'missing' ? /已断开或不可用/ : /请选择实体麦克风/);
    } else {
      assert.equal(JSON.stringify(calls[1]), JSON.stringify({ audio: { deviceId: { exact: 'usb' }, echoCancellation: true, noiseSuppression: true }, video: false }));
      if (scenario === 'overconstrained') {
        assert.match(tree.root.findByProps({ role: 'alert' }).children.join(''), /已断开或不可用/);
      } else if (scenario === 'late') {
        await act(async () => button('断开 Qwen').props.onClick());
        await act(async () => { resolveCapture(stream); await new Promise(resolve => setImmediate(resolve)); });
        assert.equal(stopped, 1, 'late capture must stop after cancellation');
      } else {
        const info = () => tree.root.findByProps({ 'aria-label': 'Qwen 实际麦克风' }).children.join('');
        assert.match(info(), /USB 耳机麦克风.*muted=false.*enabled=true.*live.*48000/);
        assert.doesNotMatch(info(), /never-show/);
        await act(async () => { track.muted = true; (track.onmute as unknown as () => void)(); });
        assert.match(info(), /muted=true/);
        await act(async () => button('断开 Qwen').props.onClick());
        assert.equal(stopped, 1);
        assert.match(info(), /ended/);
        await act(async () => { resolveState(Response.json({})); await new Promise(resolve => setImmediate(resolve)); });
      }
    }
    assert.equal(contextsClosed, 2, 'both attempted sessions close their context');
  });
}

test('known virtual inputs are rejected without requiring English physical microphone names', async () => {
  const { isVirtualInput } = await import('../../app/studio/audio-devices');
  for (const label of ['Node Virtual Mic', '默认 - node virtual mic', 'BlackHole 2ch', 'BLACKHOLE 16ch']) assert.equal(isVirtualInput(label), true);
  for (const label of ['MacBook Pro 麦克风', 'USB 耳机麦克风', 'マイク', 'Mikrofon', 'External Headset']) assert.equal(isVirtualInput(label), false);
});

for (const sourceKind of ['live-canvas', 'file', 'idle', 'avatar']) {
  test(`selecting Qwen displays the avatar before connecting from ${sourceKind}`, async t => {
    const b = browser(t), commands: { path: string; payload: any }[] = [];
    let state = {
      source: { kind: sourceKind, url: '', revision: 1, playing: true, startedAt: 0, loop: true },
      capture: { running: false, error: '', windowID: null },
      frames: { incoming: 0, outgoing: 0 }, audio: { incoming: 0, outgoing: 0 },
    };
    const noop = () => null;
    const filename = new URL('../../app/studio/console.tsx', import.meta.url), localRequire = createRequire(filename);
    const mocks: Record<string, unknown> = {
      'next/dynamic': () => () => React.createElement('div', { 'data-provider': 'qwen' }),
      './media': {
        useStudio: () => ({ state, error: '' }),
        async command(path: string, payload: any) {
          commands.push({ path, payload: { ...payload } });
          state = { ...state, source: { ...state.source, kind: payload.kind, revision: state.source.revision + 1 } };
        },
        OutputVideo: ({ source }: { source: { kind: string } }) => React.createElement('div', { 'data-source': source.kind }),
        PcmMonitor: noop, studioHeaders: noop,
      },
      './levels': { AnalyserMeter: noop, BlackHoleMeter: noop, IncomingMeter: noop },
      './studio.scss': {},
    };
    const module = { exports: {} as any };
    runInNewContext(transformSync(readFileSync(filename, 'utf8'), { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code, {
      ...b, module, exports: module.exports, setTimeout, clearTimeout,
      require: (id: string) => id in mocks ? mocks[id] : localRequire(id),
    });
    let tree: any;
    await act(async () => { tree = Renderer.create(React.createElement(module.exports.default)); });
    t.after(async () => { await act(async () => tree.unmount()); });
    const select = () => tree.root.findByProps({ 'aria-label': '语音模型' });
    if (sourceKind !== 'live-canvas') assert.equal(select().props.value, 'qwen', 'Qwen must be selected on startup without a manual click');
    await act(async () => select().props.onChange({ target: { value: 'qwen' } }));
    assert.equal(select().props.value, 'qwen');
    assert.equal(tree.root.findByProps({ 'data-source': 'avatar' }).props['data-source'], 'avatar');
    assert.equal(tree.root.findAllByType('iframe').length, 0, 'old canvas editor must be unmounted');
    assert.deepEqual(commands, sourceKind === 'avatar' ? [] : [{ path: 'source', payload: { kind: 'avatar' } }]);
  });
}

test('duplicate consoles do not open media streams and take over only after the first closes', async t => {
  const b = browser(t);
  let held = false, waiting: (() => void) | undefined, mediaReads = 0;
  b.navigator.locks.request = async (_name: string, _options: object, callback: (lock: object | null) => Promise<void>) => {
    if (held) await new Promise<void>(resolve => { waiting = resolve; });
    held = true;
    try { await callback({}); } finally { held = false; waiting?.(); waiting = undefined; }
  };
  const filename = new URL('../../app/studio/console.tsx', import.meta.url), localRequire = createRequire(filename);
  const noop = () => null;
  const mocks: Record<string, unknown> = {
    'next/dynamic': () => noop,
    './media': { useStudio: () => { mediaReads++; return { state: null, error: '' }; }, command: noop, studioHeaders: noop, OutputVideo: noop, PcmMonitor: noop },
    './levels': { AnalyserMeter: noop, BlackHoleMeter: noop, IncomingMeter: noop }, './studio.scss': {},
  };
  const module = { exports: {} as any };
  runInNewContext(transformSync(readFileSync(filename, 'utf8'), { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code, {
    ...b, module, exports: module.exports, AbortController, setTimeout, clearTimeout,
    require: (id: string) => id in mocks ? mocks[id] : localRequire(id),
  });
  let first: any, second: any;
  t.after(async () => { await act(async () => { first?.unmount(); second?.unmount(); }); });
  await act(async () => { first = Renderer.create(React.createElement(module.exports.default)); });
  const before = mediaReads;
  await act(async () => { second = Renderer.create(React.createElement(module.exports.default)); });
  assert.equal(mediaReads, before, 'duplicate page must not poll or open media subscribers');
  assert.match(second.root.findByProps({ role: 'status' }).children.join(''), /另一标签页/);
  await act(async () => { first.unmount(); first = null; });
  assert.ok(mediaReads > before, 'waiting page takes over when the owner closes');
  assert.equal(second.root.findByProps({ 'aria-label': '语音模型' }).props.value, 'qwen');
});
