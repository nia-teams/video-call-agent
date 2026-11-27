import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
const { act, create } = require('react-test-renderer');

test('actual Live Canvas panel starts WebRTC from WeCom readiness, routes virtual output and closes on hangup', async t => {
  let studio: any = { source: { kind: 'live-canvas', revision: 3 }, autoCall: { id: 'a', phase: 'capturing', windowID: 7, message: '采集中' }, capture: { running: true, windowID: 7 } };
  let microphone = 0, relays = 0, relayClosed = 0, peerClosed = 0, leaseReleased = 0, requests = 0, outputClosed = 0, attached = 0, played = 0;
  const sinks: string[] = [], storage = new Map<string, string>();
  const track = { kind: 'audio', stop() {} }, stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  const player = { srcObject: null, muted: false, async play() { played++; }, async setSinkId(sink: string) { sinks.push(sink); } };
  let peer: any;
  class Peer {
    localDescription = { sdp: 'test-offer' }; connectionState = 'new';
    channel: any = { readyState: 'open', send() {}, close() {} };
    constructor() { peer = this; }
    addTrack(actual: unknown, actualStream: unknown) { assert.equal(actual, track); assert.equal(actualStream, stream); }
    createDataChannel() { return this.channel; }
    async createOffer() { return { type: 'offer', sdp: 'test-offer' }; }
    async setLocalDescription() {} async setRemoteDescription() {}
    close() { peerClosed++; }
  }
  const devices = Object.assign(new EventTarget(), {
    async enumerateDevices() { return [{ kind: 'audiooutput', deviceId: 'virtual', label: 'Node Audio Send' }]; },
    async getUserMedia() { microphone++; throw new Error('must not read microphone'); },
  });
  const navigator = { mediaDevices: devices, locks: { request: async (name: string, _options: unknown, fn: (lock: object) => unknown) => {
    const result = await fn({ name }); if (name === 'wecom-studio-ai-provider') leaseReleased++; return result;
  } } };
  const window = Object.assign(new EventTarget(), { RTCPeerConnection: Peer, setTimeout, clearTimeout,
    localStorage: { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value) } });
  for (const [key, value] of Object.entries({ window, navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (old) Object.defineProperty(globalThis, key, old); else Reflect.deleteProperty(globalThis, key); });
  }
  const filename = new URL('../../app/live-canvas/panel.tsx', import.meta.url), localRequire = createRequire(filename);
  const fetch = async (url: string, options: RequestInit) => {
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    assert.equal(url, '/api/live/session'); requests++;
    assert.equal(JSON.parse(options.body as string).sdp, 'test-offer');
    return Response.json({ session: { id: 'test' }, canvasToken: 'canvas', transport: { sdp: 'answer' } });
  };
  const mocks: Record<string, unknown> = {
    './live-canvas.css': {}, './components/CanvasStage': { CanvasStage: () => null },
    './publisher': { useCanvasPublisher: () => '' },
    '../studio/media': { useStudio: () => ({ state: studio }) },
    '../../lib/live-canvas/webrtc': { waitForIce: async () => {} },
    './wecom-output': { createWecomAudioOutput: async (sink: string, label: string) => {
      sinks.push(sink); assert.equal(label, 'Node Audio Send');
      return { async attach() { attached++; }, async resume() {}, close() { outputClosed++; } };
    } },
    './wecom-audio': { createWecomAudioInput: async () => { relays++; return { stream, close() { relayClosed++; } }; } },
  };
  const module = { exports: {} as any };
  runInNewContext(transformSync(readFileSync(filename, 'utf8'), { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code, {
    module, exports: module.exports, window, navigator, RTCPeerConnection: Peer,
    fetch, AbortController, setTimeout, clearTimeout,
    require: (id: string) => id in mocks ? mocks[id] : localRequire(id),
  });
  let root: any;
  await act(async () => { root = create(React.createElement(module.exports.default, { sourceRevision: 3 }), { createNodeMock: (element: any) => element.type === 'audio' ? player : null }); });
  t.after(async () => { await act(async () => root.unmount()); });
  assert.equal(requests, 0);
  studio = { ...studio, autoCall: { ...studio.autoCall, phase: 'ready' } };
  await act(async () => root.update(React.createElement(module.exports.default, { sourceRevision: 3 })));
  assert.equal(requests, 1); assert.equal(relays, 1); assert.equal(microphone, 0); assert.deepEqual(sinks, ['virtual']);
  await act(async () => peer.ontrack({ streams: [stream], track })); assert.equal(attached, 1); assert.equal(played, 1); assert.equal(player.srcObject, stream); assert.equal(player.muted, true, 'the decoding element must not duplicate virtual output');
  await act(async () => peer.channel.onmessage({ data: JSON.stringify({ type: 'session.started' }) }));
  await act(async () => root.update(React.createElement(module.exports.default, { sourceRevision: 3 })));
  assert.equal(requests, 1, 'repeated ready state cannot redial');
  studio = { ...studio, autoCall: { ...studio.autoCall, phase: 'ended' }, capture: { ...studio.capture, running: false } };
  await act(async () => root.update(React.createElement(module.exports.default, { sourceRevision: 3 })));
  assert.equal(peerClosed, 1); assert.equal(relayClosed, 1); assert.equal(leaseReleased, 1); assert.equal(outputClosed, 1);
});
