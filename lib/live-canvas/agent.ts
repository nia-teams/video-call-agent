import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { streamedTool, type Canvas, type Emit } from './canvas';
import { BACKEND_PROMPT } from './prompts';

const s = (description: string) => ({ type: 'string', description });
const i = (description: string) => ({ type: 'integer', description });
function tool(name: string, description: string, properties: Record<string, object>, required: string[]): ChatCompletionTool {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
}
const commentary = s('First field: natural, brief spoken explanation of this visual in reading order.');
const title = s('Short revision label.');
const tools = [
  tool('render_canvas_card', 'Replace the canvas with a new diagram.', { commentary, html: s('Complete self-contained HTML/CSS/SVG. Emit after commentary.'), title }, ['commentary', 'html']),
  tool('canvas_edit', 'Update the existing canvas using one exact, unique replacement.', { commentary, old_string: s('Unique exact substring of the current canvas.'), new_string: s('Replacement; may be empty to delete.'), title }, ['commentary', 'old_string', 'new_string']),
  tool('canvas_read', 'Read raw canvas source and revision history.', { offset: i('1-based first line.'), limit: i('Maximum lines.') }, []),
  tool('restore_canvas_revision', 'Restore a retained revision.', { revision: i('Revision to restore.') }, ['revision']),
  tool('session_commentary_append', 'Send spoken explanation when no canvas tool speaks.', { content: s('Short, natural spoken Chinese.') }, ['content']),
  tool('session_thinking_append', 'Give private context to the voice assistant without asking it to speak.', { content: s('Brief context, not chain-of-thought.') }, ['content']),
];

export async function runAgent(apiKey: string, state: Canvas, tap: string, emit: Emit, signal: AbortSignal) {
  const openai = new OpenAI({ apiKey, baseURL: process.env.OPENAI_BACKEND_BASE_URL || 'https://api.openai.com/v1', maxRetries: 0, timeout: 45_000 });
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: BACKEND_PROMPT },
    { role: 'user', content: JSON.stringify({ trigger: tap ? 'canvas_tap' : 'client_delegation', canvasTap: tap || undefined, currentCanvasRevision: state.current?.revision ?? 0, recentTranscriptDeltas: state.transcripts }) },
  ];
  for (let step = 0; step < 6; step++) {
    signal.throwIfAborted();
    const calls = new Map<number, { id: string; name: string; tool: ReturnType<typeof streamedTool> }>();
    let prose = '', finishReason: string | null = null;
    try {
      const stream = await openai.chat.completions.create({
        stream: true, model: process.env.OPENAI_BACKEND_MODEL || 'gpt-4.1', messages, tools,
      }, { signal });
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;
        finishReason = choice.finish_reason ?? finishReason;
        prose += choice.delta?.content ?? '';
        for (const delta of choice.delta?.tool_calls ?? []) {
          const call = calls.get(delta.index) ?? { id: '', name: '', tool: streamedTool(state, emit) };
          calls.set(delta.index, call);
          if (calls.size > 8) throw new Error('Too many calls');
          call.id += delta.id ?? '';
          call.name += delta.function?.name ?? '';
          // Commentary is emitted here, not after the model turn completes.
          call.tool.push(call.name, delta.function?.arguments ?? '');
        }
      }
      signal.throwIfAborted();
      if (!finishReason || finishReason === 'length' || finishReason === 'content_filter') throw new Error('Incomplete model response');
    } catch {
      for (const call of calls.values()) call.tool.resetPreview();
      if (signal.aborted) return;
      throw new Error('后台模型流中断。请检查后台模型、密钥和网关配置。');
    }
    if (!calls.size) return;
    const ordered = [...calls].sort(([a], [b]) => a - b).map(([, call]) => call);
    messages.push({ role: 'assistant', content: prose || null, tool_calls: ordered.map(call => ({
      id: call.id, type: 'function', function: { name: call.name, arguments: call.tool.args },
    })) });
    for (const call of ordered) {
      const result = call.tool.finish(call.name);
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  throw new Error('后台模型达到工具调用步数上限。');
}
