import { isLocalRequest } from '../../../../lib/studio/server-guard';
import { createCanvas, deleteCanvas, getCanvas } from '../../../../lib/live-canvas/canvas';
import { FRONTEND_VOICE_PROMPT } from '../../../../lib/live-canvas/prompts';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  if (!isLocalRequest(request)) return Response.json({ error: "Local access only" }, { status: 403 });
  const { sdp, voice } = await request.json().catch(() => ({})) ?? {};
  if (typeof sdp !== 'string' || !sdp.trim() || sdp.length > 100_000) {
    return Response.json({ error: '需要有效的 WebRTC SDP offer。' }, { status: 400 });
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return Response.json({ error: '未设置 OPENAI_API_KEY。可使用无 Key 演示。' }, { status: 503 });
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  try {
    const openingDeveloperMsg = {
      type: 'message', role: 'developer', content: [{ type: 'input_text', text: '用户刚拨通你的语音电话。请简短问候，然后听对方说。' }],
    };
    const response = await fetch(`${base}/live/sessions`, {
      method: 'POST', cache: 'no-store', signal: AbortSignal.any([request.signal, AbortSignal.timeout(25_000)]),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: {
          model: process.env.OPENAI_LIVE_MODEL || 'gpt-live-1', instructions: FRONTEND_VOICE_PROMPT,
          audio: { output: { voice: typeof voice === 'string' && /^[a-z0-9_-]{1,40}$/i.test(voice) ? voice : 'marin' } },
          delegation: { type: 'client', acknowledgement_delay_ms: 800 }, store: false, input: [openingDeveloperMsg],
        }, transport: { type: 'webrtc', sdp },
      }),
    });
    if (!response.ok) return Response.json({ error: `GPT-Live 会话创建被拒绝 (HTTP ${response.status})。请检查端点、模型与权限。` }, { status: 502 });
    const answer = await response.json();
    const id = answer?.session?.id, answerSdp = answer?.transport?.sdp;
    if (typeof id !== 'string' || !id || typeof answerSdp !== 'string' || !answerSdp) {
      return Response.json({ error: 'GPT-Live 未返回有效的会话 ID 或 SDP answer。' }, { status: 502 });
    }
    const canvas = createCanvas('live', id);
    return Response.json({ session: { id }, transport: { sdp: answerSdp }, canvasToken: canvas.id }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ error: '未能建立 GPT-Live 会话。请检查配置或网络后重试。' }, { status: 502 });
  }
}

export async function DELETE(request: Request) {
  if (!isLocalRequest(request)) return Response.json({ error: "Local access only" }, { status: 403 });
  const body = await request.json().catch(() => null);
  const state = getCanvas(body?.canvasToken, 'live');
  if (state && state.providerId === body?.sessionId) deleteCanvas(body.canvasToken);
  return new Response(null, { status: 204 });
}
