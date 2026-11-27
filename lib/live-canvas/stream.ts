import type { Canvas, Emit } from './canvas';
import type { StreamEvent } from './protocol';

export function streamResponse(request: Request, state: Canvas, run: (emit: Emit, signal: AbortSignal) => Promise<void>) {
  if (state.busy) return Response.json({ error: '画板正在处理上一条请求。' }, { status: 409 });
  state.busy = true;
  const stop = new AbortController();
  const signal = AbortSignal.any([request.signal, stop.signal]);
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit: Emit = event => { if (!signal.aborted) controller.enqueue(enc.encode(JSON.stringify(event) + '\n')); };
      try { await run(emit, signal); }
      catch (error) { emit({ type: 'error', content: error instanceof Error ? error.message : '流式请求失败。' }); }
      finally { state.busy = false; if (!stop.signal.aborted) controller.close(); }
    },
    cancel(reason) { stop.abort(reason); },
  });
  return new Response(body, { headers: {
    'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no',
  } });
}

export async function readNdjson(response: Response, onEvent: (event: StreamEvent) => void) {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || `请求失败 (${response.status})`);
  }
  if (!response.body) throw new Error('服务没有返回流。');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) pending += value;
      const lines = pending.split('\n');
      pending = lines.pop()!;
      if (done && pending.trim()) lines.push(pending);
      for (const line of lines) if (line.trim()) {
        const event = JSON.parse(line) as StreamEvent;
        if (event.type === 'error') throw new Error(event.content);
        onEvent(event);
      }
      if (done) break;
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
