import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { useLiveCanvasAutoCall } from '../../app/live-canvas/use-auto-call';
import { claimAutoCall } from '../../app/studio/auto-call';
import type { StudioState } from '../../app/studio/media';
const { act, create } = require('react-test-renderer');
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const state = (id: string, phase = 'ready', running = true) => ({
  source: { kind: 'live-canvas', revision: 3 },
  autoCall: { id, phase, windowID: 7 }, capture: { running, windowID: 7 },
}) as StudioState;
async function harness(t: any, claim: (id: string) => Promise<boolean> = async () => true) {
  const starts: string[] = [], stops: number[] = [], errors: string[] = [];
  let current = state('a', 'capturing'), busy = false, outputReady = true, source = '', root: any;
  function Harness() {
    useLiveCanvasAutoCall(current, { sourceRevision: 3, busy, outputReady, source, claim,
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
test('Live Canvas starts once when capture and output are ready, ends on hangup and starts the next call', async t => {
  const f = await harness(t); assert.equal(f.starts.length, 0);
  await f.update(state('a'), { outputReady: false }); assert.equal(f.starts.length, 0);
  await f.update(state('a'), { outputReady: true }); assert.deepEqual(f.starts, ['a']);
  await f.update(state('a'), { busy: true, source: 'wecom' });
  await f.update(state('a'), { busy: false }); assert.deepEqual(f.starts, ['a']);
  await f.update(state('a', 'ended', false)); assert.equal(f.stops.length, 1);
  await f.update(state('a', 'ended', false)); assert.equal(f.stops.length, 1);
  await f.update(state('b')); assert.deepEqual(f.starts, ['a', 'b']);
});
test('Live Canvas rejects stale editors and mismatched windows and stops on capture/output loss', async t => {
  const f = await harness(t);
  const wrong = state('a'); wrong.source.revision = 2;
  await f.update(wrong); assert.equal(f.starts.length, 0);
  const window = state('a'); window.capture.windowID = 8;
  await f.update(window); assert.equal(f.starts.length, 0);
  await f.update(state('a')); assert.equal(f.starts.length, 1);
  await f.update(state('a', 'ready', false)); assert.equal(f.stops.length, 1);
  await f.update(state('b')); assert.equal(f.starts.length, 2);
  await f.update(state('b'), { outputReady: false }); assert.equal(f.stops.length, 2);
});
test('hangup during claim prevents late connection; another tab cannot duplicate the call', async t => {
  let resolve!: (value: boolean) => void;
  const f = await harness(t, () => new Promise<boolean>(r => { resolve = r; }));
  await f.update(state('a')); await f.update(state('a', 'ended', false));
  await act(async () => resolve(true)); assert.equal(f.starts.length, 0);
  const other = await harness(t, async () => false); await other.update(state('a')); assert.equal(other.starts.length, 0);
});
test('a connected WeCom call replaces a microphone test/demo; coordination failure is visible', async t => {
  const f = await harness(t); await f.update(state('a'), { busy: true, source: 'demo' }); assert.equal(f.stops.length, 1);
  await f.update(state('a'), { busy: false }); assert.deepEqual(f.starts, ['a']);
  const failed = await harness(t, async () => { throw new Error('storage'); }); await failed.update(state('a')); assert.equal(failed.errors.length, 1);
});
test('Live Canvas has its own cross-tab call claim', async () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const locks = { request: async (_name: string, _options: unknown, action: () => unknown) => action() } as unknown as Pick<LockManager, 'request'>;
  assert.equal(await claimAutoCall('a', { storage, locks, provider: 'live-canvas' }), true);
  assert.equal(await claimAutoCall('a', { storage, locks, provider: 'live-canvas' }), false);
  assert.equal(await claimAutoCall('a', { storage, locks, provider: 'qwen' }), true);
  assert.equal(await claimAutoCall('a', { storage, locks }), false);
});
