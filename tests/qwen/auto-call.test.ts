import { autoCaptureEnabled, cameraSwitchArgs, createCallAutomation } from '../../automation/obs-wecom/call-automation.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { useQwenAutoCall } from '../../app/qwen/use-auto-call';
import { qwenOutput } from '../../app/qwen/audio-devices';
import { claimAutoCall } from '../../app/studio/auto-call';
import type { StudioState } from '../../app/studio/media';
const { act, create } = require('react-test-renderer');
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const state = (id: string, phase = 'ready', running = true) => ({
  autoCall: { id, phase, windowID: 7 }, capture: { running, windowID: 7 },
}) as StudioState;

async function harness(t: any, claim: (id: string) => Promise<boolean> = async () => true) {
  const starts: string[] = [], stops: number[] = [], errors: string[] = [];
  let current = state('a', 'capturing'), busy = false, outputReady = true, source = 'wecom', root: any;
  function Harness() {
    useQwenAutoCall(current, { busy, outputReady, source, claim,
      start: () => starts.push(current.autoCall!.id), stop: () => stops.push(1), onError: message => errors.push(message) });
    return null;
  }
  async function update(next = current, options: { busy?: boolean; outputReady?: boolean; source?: string } = {}) {
    current = next; busy = options.busy ?? busy; outputReady = options.outputReady ?? outputReady; source = options.source ?? source;
    await act(async () => { if (root) root.update(React.createElement(Harness)); else root = create(React.createElement(Harness)); });
  }
  t.after(async () => { await act(async () => root?.unmount()); });
  await update(); return { update, starts, stops, errors };
}

test('connects once after capture/output readiness, ends on hangup and connects the next call', async t => {
  const f = await harness(t); assert.equal(f.starts.length, 0);
  await f.update(state('a'), { outputReady: false }); assert.equal(f.starts.length, 0);
  await f.update(state('a'), { outputReady: true }); assert.deepEqual(f.starts, ['a']);
  await f.update(state('a'), { busy: true });
  await f.update(state('a'), { busy: false }); assert.deepEqual(f.starts, ['a'], 'manual disconnect must not trigger reconnection');
  await f.update(state('a', 'ended', false)); assert.equal(f.stops.length, 1);
  await f.update(state('a', 'ended', false)); assert.equal(f.stops.length, 1);
  await f.update(state('b')); assert.deepEqual(f.starts, ['a', 'b']);
});

test('hangup while coordination is pending prevents a late connection', async t => {
  let resolve!: (value: boolean) => void;
  const f = await harness(t, () => new Promise<boolean>(r => { resolve = r; }));
  await f.update(state('a')); await f.update(state('a', 'ended', false));
  await act(async () => resolve(true)); assert.equal(f.starts.length, 0); assert.equal(f.stops.length, 1);
});

test('capture loss stops the owned session; another tab claim prevents automatic connection', async t => {
  const f = await harness(t); await f.update(state('a')); await f.update(state('a', 'ready', false)); assert.equal(f.stops.length, 1);
  const other = await harness(t, async () => false); await other.update(state('a')); assert.equal(other.starts.length, 0);
});

test('a call replaces a local microphone test and storage errors are visible', async t => {
  const f = await harness(t); await f.update(state('a'), { busy: true, source: 'microphone' }); assert.equal(f.stops.length, 1);
  await f.update(state('a'), { busy: false }); assert.deepEqual(f.starts, ['a']);
  const failed = await harness(t, async () => { throw new Error('blocked'); }); await failed.update(state('a')); assert.equal(failed.errors.length, 1);
});

test('Qwen auto calls coordinate across tabs independently of Live Canvas', async () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const locks = { request: async (_name: string, _options: unknown, action: () => unknown) => action() } as unknown as Pick<LockManager, 'request'>;
  assert.equal(await claimAutoCall('a', { storage, locks, provider: 'qwen' }), true);
  assert.equal(await claimAutoCall('a', { storage, locks, provider: 'qwen' }), false);
  assert.equal(await claimAutoCall('a', { storage, locks, provider: 'live-canvas' }), true);
});

test('prefers Node Audio Send and preserves a valid explicit virtual-output choice', () => {
  const devices = [
    { kind: 'audiooutput', deviceId: 'default', label: 'Node Audio Send' },
    { kind: 'audiooutput', deviceId: 'blackhole', label: 'BlackHole 2ch' },
    { kind: 'audiooutput', deviceId: 'node', label: 'Node Audio Send (Virtual)' },
    { kind: 'audioinput', deviceId: 'mic', label: 'MacBook Pro麦克风' },
  ] as MediaDeviceInfo[];
  assert.equal(qwenOutput(devices), 'node'); assert.equal(qwenOutput(devices, 'missing'), 'node');
  assert.equal(qwenOutput(devices, 'blackhole'), 'blackhole'); assert.equal(qwenOutput(devices.filter(d => d.deviceId !== 'node')), '');
});


test('default incoming-call pipeline captures, starts Qwen once, and closes it on hangup', async t => {
  const f = await harness(t);
  const commands: string[] = [];
  let published: any;
  const capture = { running: false, windowID: null as number | null, error: '' };
  const current = { capture, lastVideo: 0 };
  const automation = createCallAutomation({
    enabled: autoCaptureEnabled({}),
    state: async () => current,
    changed: (value: any) => { published = value; },
    sleep: async () => {},
    command: async (path: string, payload: any) => {
      commands.push(path);
      if (path === 'windows') return [{ id: 7, title: '00:04', width: 360, height: 640 }];
      if (path === 'capture/start') { capture.running = true; capture.windowID = payload.windowID; current.lastVideo = 1; }
      if (path === 'capture/stop') capture.running = false;
      return {};
    },
  });
  t.after(() => automation.close());
  assert.ok(cameraSwitchArgs({}).includes('--auto-answer'));
  await automation.event({ event: 'call_connected', id: 'incoming-qwen-1', windowID: 7 });
  assert.equal(published.phase, 'ready');
  assert.ok(commands.includes('capture/start'));
  await f.update({ ...current, autoCall: published } as StudioState);
  assert.deepEqual(f.starts, ['incoming-qwen-1']);
  await automation.event({ event: 'call_connected', id: 'incoming-qwen-1', windowID: 7 });
  await f.update({ ...current, autoCall: published } as StudioState);
  assert.equal(f.starts.length, 1);
  await automation.event({ event: 'call_ended', id: 'incoming-qwen-1' });
  await f.update({ ...current, autoCall: published } as StudioState);
  assert.equal(capture.running, false);
  assert.equal(f.stops.length, 1);
});
