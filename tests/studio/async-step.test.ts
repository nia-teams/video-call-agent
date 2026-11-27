import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asyncStep } from '../../lib/studio/async-step';

test('pending device setup or saturated HTTP queue ends with a specific timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const pending = asyncStep(new Promise<void>(() => {}), 4000, '自动音频未允许', controller.signal);
  const rejected = assert.rejects(pending, /自动音频未允许/);
  t.mock.timers.tick(4000);
  await rejected;
});

test('hangup releases a pending initialization immediately and ignores late completion', async () => {
  const controller = new AbortController();
  let finish!: (value: number) => void;
  const pending = asyncStep(new Promise<number>(resolve => { finish = resolve; }), 5000, '状态超时', controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort(); finish(1);
  await rejected;
});
