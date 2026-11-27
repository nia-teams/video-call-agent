import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DELETE, POST as createSession } from '../../app/api/live/session/route';
import { POST as delegate } from '../../app/api/live/delegate/route';
import { readNdjson } from '../../lib/live-canvas/stream';
import type { StreamEvent } from '../../lib/live-canvas/protocol';

const request = (route: string, body: object, method = 'POST') => new Request(`http://localhost/api/live/${route}`, { method, headers: { host: 'localhost', origin: 'http://localhost' }, body: JSON.stringify(body) });

test('live route posts the HTTP WebRTC contract, then streams a multi-step SDK tool loop', async () => {
  const requests: { path: string; json: any }[] = [];
  const calls = [
    { name: 'render_canvas_card', args: ['{"commentary":"先讲', '。"', ',"html":"<svg><g><text>原文</text></g></svg>"}'] },
    { name: 'canvas_read', args: ['{}'] },
    { name: 'canvas_edit', args: ['{"commentary":"更改。","old_string":"原文","new_string":"高亮"}'] },
    { name: 'session_thinking_append', args: ['{"content":"最后的背景"}'] },
  ];
  let step = 0;
  const gateway = createServer(async (req, res) => {
    const raw = [];
    for await (const chunk of req) raw.push(chunk);
    requests.push({ path: req.url!, json: JSON.parse(Buffer.concat(raw).toString()) });
    if (req.url === '/v1/live/sessions') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ session: { id: 'mock_live' }, transport: { sdp: 'mock answer' } }));
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    const call = calls[step++];
    const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (call) {
      send({ tool_calls: [{ index: 0, id: `call_${step}`, type: 'function', function: { name: call.name, arguments: '' } }] });
      for (const args of call.args) send({ tool_calls: [{ index: 0, function: { arguments: args } }] });
      send({}, 'tool_calls');
    } else send({}, 'stop');
    res.end('data: [DONE]\n\n');
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const addr = gateway.address();
  assert.ok(addr && typeof addr === 'object');
  const base = `http://127.0.0.1:${addr.port}/v1`;
  const config = { OPENAI_API_KEY: 'mock-key', OPENAI_BASE_URL: base, OPENAI_BACKEND_API_KEY: 'mock-key', OPENAI_BACKEND_BASE_URL: base };
  const envBefore = Object.fromEntries(Object.keys(config).map(k => [k, process.env[k]]));
  Object.assign(process.env, config);
  try {
    const opening = await createSession(request('session', { sdp: 'mock offer', voice: 'marin' }));
    assert.equal(opening.status, 200);
    const answer = await opening.json();
    assert.deepEqual(answer.transport, { sdp: 'mock answer' });
    const { path, json } = requests[0];
    assert.equal(path, '/v1/live/sessions');
    assert.deepEqual(json.transport, { type: 'webrtc', sdp: 'mock offer' });
    assert.deepEqual(json.session.delegation, { type: 'client', acknowledgement_delay_ms: 800 });
    assert.equal(json.session.store, false);
    assert.equal(json.session.input[0].role, 'developer');
    const body = { sessionId: answer.session.id, canvasToken: answer.canvasToken, delegationId: 'mock_del', transcripts: [{ role: 'user', text: '想看图解', seq: 1 }] };
    assert.equal((await delegate(request('delegate', { ...body, canvasToken: 'wrong' }))).status, 404);
    const events: StreamEvent[] = [];
    await readNdjson(await delegate(request('delegate', body)), event => events.push(event));
    assert.deepEqual(events[0], { type: 'commentary', content: '先讲。' });
    assert.equal(events[1].type === 'canvas_stream' && events[1].done, false);
    assert.ok(events.some(e => e.type === 'canvas_stream' && e.done && e.action === 'edit' && e.html.includes('高亮')));
    assert.deepEqual(events.at(-1), { type: 'thinking', content: '最后的背景' });
    assert.equal(requests.length, 6);
    assert.equal(requests[1].path, '/v1/chat/completions');
    assert.equal(requests[1].json.stream, true);
    assert.match(requests[1].json.messages[1].content, /想看图解/);
    assert.match(requests[3].json.messages.at(-1).content, /原文/);
    assert.equal((await DELETE(request('session', body, 'DELETE'))).status, 204);
    assert.equal((await delegate(request('delegate', body))).status, 404);
  } finally {
    for (const [k, v] of Object.entries(envBefore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await new Promise<void>(resolve => gateway.close(() => resolve()));
  }
});
