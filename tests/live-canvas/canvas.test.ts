import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hostHtml } from '../../app/live-canvas/components/canvasHost';
import { createCanvas, executeCanvasTool, streamedTool } from '../../lib/live-canvas/canvas';
import { extractStreamingHtmlArg, extractStreamingStringArg, prepareStreamingPreview } from '../../lib/live-canvas/preview';
import { truncateAppendContent, type StreamEvent } from '../../lib/live-canvas/protocol';

const pick = (json: string) => extractStreamingStringArg(json, 'commentary');
test('string extractor handles quote escapes, unicode, incomplete escapes, and top-level boundaries', () => {
  assert.deepEqual(pick(String.raw`{"commentary":"a\"\n\u4e2d\u6`), { value: 'a"\n中', closed: false });
  assert.deepEqual(pick(String.raw`{"nested":{"commentary":"decoy"},"commentary":"讲解"`), { value: '讲解', closed: true });
  assert.deepEqual(pick('{"nested":{"commentary":"decoy"}}'), { value: '', closed: false });
  assert.equal(extractStreamingHtmlArg(String.raw`{"commentary":"讲解","html":"<g id=\"one\">`), '<g id="one">');
});

test('preview auto-closes SVG groups, strips incomplete tags, and keeps only balanced partial CSS', () => {
  assert.deepEqual(prepareStreamingPreview('<svg><g><circle>'), { html: '<svg><g><circle></g></svg>', styles: '' });
  assert.deepEqual(prepareStreamingPreview('<svg><g><circle r="4"/><pat'), { html: '<svg><g><circle r="4"/></g></svg>', styles: '' });
  assert.deepEqual(prepareStreamingPreview('<div>x</div><style>/* } */ .a{color:red}.b{color:'), { html: '<div>x</div>', styles: '.a{color:red}' });
  assert.equal(prepareStreamingPreview('<div>safe</div><script>alert(1)</script>').html, '<div>safe</div>');
});

test('UTF-8 truncation respects code points and the 1500 byte budget', () => {
  const text = '中'.repeat(499) + '🧡';
  const result = truncateAppendContent(text);
  assert.deepEqual(result, { content: '中'.repeat(499), truncated: true, originalBytes: 1501 });
  assert.equal(truncateAppendContent('🧡'.repeat(375)).truncated, false);
});

test('canvas_edit uses a unique, literal replacement; read and restore honor 25 revisions', () => {
  const { state } = createCanvas('demo');
  const events: StreamEvent[] = [];
  const emit = (event: StreamEvent) => events.push(event);
  assert.equal(executeCanvasTool(state, 'render_canvas_card', { html: '<p>one\none\nunique</p>' }, emit).shown, true);
  assert.equal(executeCanvasTool(state, 'canvas_edit', { old_string: 'one', new_string: 'wrong' }, emit).shown, false);
  assert.equal(executeCanvasTool(state, 'canvas_edit', { old_string: 'unique', new_string: '$&' }, emit).shown, true);
  assert.equal(state.current?.rawHtml, '<p>one\none\n$&</p>');
  const read = executeCanvasTool(state, 'canvas_read', { offset: 2, limit: 1 }, emit);
  assert.ok('content' in read);
  assert.equal(read.content, 'one');
  assert.equal(executeCanvasTool(state, 'restore_canvas_revision', { revision: 1 }, emit).shown, true);
  for (let step = 0; step < 24; step++) executeCanvasTool(state, 'render_canvas_card', { html: `<p>${step}</p>` }, emit);
  assert.equal(state.history.length, 25);
  assert.equal(state.current?.revision, 26);
  assert.equal(executeCanvasTool(state, 'restore_canvas_revision', { revision: 1 }, emit).shown, false);
  assert.equal(executeCanvasTool(state, 'restore_canvas_revision', { revision: 2 }, emit).shown, true);
  assert.equal(state.current?.rawHtml, '<p>one\none\n$&</p>');
});

test('commentary is emitted on closing quote; visual previews are throttled to 150ms', () => {
  const { state } = createCanvas('demo');
  const events: StreamEvent[] = [];
  const tool = streamedTool(state, event => events.push(event));
  const name = 'render_canvas_card';
  tool.push(name, '{"commentary":"开始', 0);
  assert.equal(events.length, 0);
  tool.push(name, '"', 1);
  assert.deepEqual(events, [{ type: 'commentary', content: '开始' }]);
  tool.push(name, ',"html":"<svg><g>', 10);
  tool.push(name, '<circle/>', 159);
  assert.equal(events.length, 2);
  tool.push(name, '<line/>', 160);
  assert.equal(events.length, 3);
  tool.push(name, '</g></svg>"}', 160);
  const result = tool.finish(name);
  assert.ok('shown' in result && result.shown);
  assert.equal(events.filter(event => event.type === 'commentary').length, 1);
  assert.equal(events.at(-1)?.type === 'canvas_stream' && (events.at(-1) as { done: boolean }).done, true);
});

test('the sandbox CSP authorizes only the exact fixed bridge script', () => {
  const script = hostHtml.match(/<script>([\s\S]*?)<\/script>/)![1];
  const hash = createHash('sha256').update(script).digest('base64');
  assert.ok(hostHtml.includes(`script-src 'sha256-${hash}'`));
  assert.ok(hostHtml.includes("default-src 'none'"));
});
