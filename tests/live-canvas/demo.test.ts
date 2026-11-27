import test from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../../app/api/live/demo/route';
import { readNdjson } from '../../lib/live-canvas/stream';
import type { CanvasFrame, StreamEvent } from '../../lib/live-canvas/protocol';

const call = (body: object) => POST(new Request('http://localhost/api/live/demo', { method: 'POST', headers: { host: 'localhost', origin: 'http://localhost' }, body: JSON.stringify(body) }));
const canvasEvents = (events: StreamEvent[]) => events.filter((e): e is CanvasFrame => e.type === 'canvas_stream');

test('POST /api/live/demo streams early commentary, progressive write/edit, tap highlight, and restore', async () => {
  const response = await call({});
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /application\/x-ndjson/);
  const all: StreamEvent[] = [];
  const times: number[] = [];
  await readNdjson(response, event => { all.push(event); times.push(performance.now()); });
  const session = all[0];
  assert.ok(session?.type === 'demo_session');
  assert.equal(all[1].type, 'commentary');
  const firstFrameIndex = all.findIndex(event => event.type === 'canvas_stream');
  assert.ok(times[firstFrameIndex] - times[1] >= 100);
  const frames = canvasEvents(all);
  for (const action of ['write', 'edit'] as const) assert.ok(frames.filter(e => e.action === action && !e.done).length >= 3);
  assert.ok(frames.some(e => !e.done && e.html.includes('</g></svg>')));
  assert.deepEqual(frames.filter(e => e.done).map(e => [e.action, e.revision]), [['write', 1], ['edit', 2]]);
  assert.match(frames.at(-1)!.html, /放下手机/);
  assert.match(frames.at(-1)!.html, /#FFE3C7/);

  const tapped: StreamEvent[] = [];
  await readNdjson(await call({ sessionId: session.content, canvasTap: '调暗灯光' }), e => tapped.push(e));
  assert.deepEqual(tapped[0], { type: 'commentary', content: '先把环境灯光调暗一点，让眼睛慢慢适应。' });
  assert.equal(canvasEvents(tapped).at(-1)!.revision, 3);
  assert.match(canvasEvents(tapped).at(-1)!.html, /id="light"[\s\S]*?<circle cx="54" cy="62" r="38"/);

  const restored: StreamEvent[] = [];
  await readNdjson(await call({ sessionId: session.content, revision: 1 }), e => restored.push(e));
  const [result] = canvasEvents(restored);
  assert.equal(result.action, 'restore');
  assert.equal(result.revision, 1);
  assert.doesNotMatch(result.html, /#FFE3C7/);
});
