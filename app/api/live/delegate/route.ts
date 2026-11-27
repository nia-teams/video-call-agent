import { isLocalRequest } from '../../../../lib/studio/server-guard';
import { runAgent } from '../../../../lib/live-canvas/agent';
import { executeCanvasTool, getCanvas } from '../../../../lib/live-canvas/canvas';
import type { Transcript } from '../../../../lib/live-canvas/protocol';
import { streamResponse } from '../../../../lib/live-canvas/stream';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  if (!isLocalRequest(request)) return Response.json({ error: "Local access only" }, { status: 403 });
  const body = await request.json().catch(() => null);
  const state = getCanvas(body?.canvasToken, 'live');
  if (!state || !body?.sessionId || state.providerId !== body.sessionId) return Response.json({ error: '找不到通话会话，请重新接通。' }, { status: 404 });
  const tap = typeof body.canvasTap === 'string' ? body.canvasTap.trim().slice(0, 400) : '';
  const revision = Number.isSafeInteger(body.revision) && body.revision > 0 ? body.revision : 0;
  const apiKey = process.env.OPENAI_BACKEND_API_KEY || process.env.OPENAI_API_KEY;
  if (!revision && !apiKey) return Response.json({ error: '未设置后台模型 API Key。' }, { status: 503 });
  if (!revision && !(body.delegationId === null ? tap : typeof body.delegationId === 'string' && body.delegationId)) {
    return Response.json({ error: '需要客户端委派 ID 或画板点击内容。' }, { status: 400 });
  }
  return streamResponse(request, state, async (emit, signal) => {
    if (revision) {
      const result = executeCanvasTool(state, 'restore_canvas_revision', { revision }, emit);
      if (!result.shown) throw new Error('此画板版本已不在历史记录中。');
      return;
    }
    const sorted = (Array.isArray(body.transcripts) ? body.transcripts.slice(-300) : [])
      .filter((item: Transcript) => item && Number.isSafeInteger(item.seq) && (item.role === 'user' || item.role === 'assistant') && typeof item.text === 'string')
      .sort((a: Transcript, b: Transcript) => a.seq - b.seq) as Transcript[];
    for (const { seq, role, text } of sorted) {
      if (seq > (state.transcripts.at(-1)?.seq ?? 0)) state.transcripts.push({ seq, role, text: text.slice(0, 600) });
    }
    state.transcripts = state.transcripts.slice(-300);
    await runAgent(apiKey!, state, tap, emit, signal);
  });
}
