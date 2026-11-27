import { isLocalRequest } from '../../../../lib/studio/server-guard';
import { createCanvas, executeCanvasTool, getCanvas } from '../../../../lib/live-canvas/canvas';
import { runDemo } from '../../../../lib/live-canvas/demo';
import { streamResponse } from '../../../../lib/live-canvas/stream';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  if (!isLocalRequest(request)) return Response.json({ error: "Local access only" }, { status: 403 });
  const body = await request.json().catch(() => ({})) ?? {};
  const tap = typeof body.canvasTap === 'string' ? body.canvasTap.trim().slice(0, 400) : '';
  const revision = Number.isSafeInteger(body.revision) && body.revision > 0 ? body.revision : 0;
  const existing = getCanvas(body.sessionId, 'demo');
  if ((body.sessionId || tap || revision) && !existing) return Response.json({ error: '演示已过期，请重新开启。' }, { status: 404 });
  const created = existing ? undefined : createCanvas('demo');
  const state = existing ?? created!.state;
  return streamResponse(request, state, async (emit, signal) => {
    if (created) emit({ type: 'demo_session', content: created.id });
    if (revision) {
      const result = executeCanvasTool(state, 'restore_canvas_revision', { revision }, emit);
      if (!result.shown) throw new Error('此画板版本已不在历史记录中。');
      return;
    }
    await runDemo(state, tap, emit, signal);
  });
}
