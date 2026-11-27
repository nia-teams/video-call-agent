import { randomUUID } from 'node:crypto';
import { prepareStreamingPreview, extractStreamingHtmlArg, extractStreamingStringArg } from './preview';
import { truncateAppendContent, type CanvasFrame, type StreamEvent, type Transcript } from './protocol';

const MAX_HISTORY = 25;
const MAX_HTML = 60_000;
const TTL = 60 * 60_000;
export const FRAME_INTERVAL = 150;
type Entry = CanvasFrame & { revision: number; title: string; rawHtml: string };
export type Emit = (event: StreamEvent) => void;
export type Input = Record<string, unknown>;
export type Canvas = {
  mode: 'live' | 'demo'; providerId?: string; current?: Entry; nextRevision: number;
  history: Entry[]; transcripts: Transcript[]; expires: number; busy: boolean;
};
// Next bundles route handlers separately; reuse the map in the same Node process.
const g = globalThis as typeof globalThis & { liveCanvasSessions?: Map<string, Canvas> };
const sessions = g.liveCanvasSessions ??= new Map<string, Canvas>();
export function createCanvas(mode: Canvas['mode'], providerId?: string) {
  const now = Date.now();
  for (const [id, state] of sessions) if (state.expires < now && !state.busy) sessions.delete(id);
  if (sessions.size >= 100) {
    const idle = [...sessions].find(([, state]) => !state.busy);
    if (!idle) throw new Error('画板会话已满，请稍后重试。');
    sessions.delete(idle[0]);
  }
  const id = randomUUID();
  const state: Canvas = { mode, providerId, nextRevision: 0, history: [], transcripts: [], expires: now + TTL, busy: false };
  sessions.set(id, state);
  return { id, state };
}
export function getCanvas(id: unknown, mode: Canvas['mode']) {
  const state = typeof id === 'string' ? sessions.get(id) : undefined;
  if (state?.mode !== mode || state.expires < Date.now()) return undefined;
  state.expires = Date.now() + TTL;
  return state;
}
export function deleteCanvas(id: string) { sessions.delete(id); }

const text = (value: unknown) => typeof value === 'string' ? value : '';
function replaceUnique(raw: string, old: string, replacement: string) {
  const index = old ? raw.indexOf(old) : -1;
  if (index < 0 || raw.indexOf(old, index + 1) >= 0) return undefined;
  return raw.slice(0, index) + replacement + raw.slice(index + old.length);
}
function sendFrame({ rawHtml: _, ...frame }: Entry, emit: Emit) { emit(frame); }
function revisions(state: Canvas) { return state.history.map(({ revision, title }) => ({ revision, title })); }
function commit(state: Canvas, rawHtml: string, action: 'write' | 'edit', title: string, emit: Emit) {
  if (!rawHtml.trim() || rawHtml.length > MAX_HTML) return { shown: false, error: 'Canvas is empty or exceeds 60,000 characters' };
  const revision = ++state.nextRevision;
  const entry: Entry = { type: 'canvas_stream', action, ...prepareStreamingPreview(rawHtml), rawHtml, done: true, revision, title: title.trim().slice(0, 90) || `Revision #${revision}` };
  state.current = entry;
  state.history.push(entry);
  if (state.history.length > MAX_HISTORY) state.history.shift();
  sendFrame(entry, emit);
  return { shown: true, revision, revisions: revisions(state) };
}
export function executeCanvasTool(state: Canvas, name: string, input: Input, emit: Emit) {
  switch (name) {
    case 'render_canvas_card': return commit(state, text(input.html), 'write', text(input.title), emit);
    case 'canvas_edit': {
      const raw = replaceUnique(state.current?.rawHtml ?? '', text(input.old_string), text(input.new_string));
      return raw !== undefined && typeof input.new_string === 'string'
        ? commit(state, raw, 'edit', text(input.title) || `Edited rev #${state.current?.revision}`, emit)
        : { shown: false, error: 'Use canvas_read; old_string must match exactly once and new_string must be a string' };
    }
    case 'canvas_read': {
      const lines = (state.current?.rawHtml ?? '').split('\n');
      const offset = typeof input.offset === 'number' ? Math.max(0, Math.floor(input.offset) - 1) : 0;
      const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.floor(input.limit) : lines.length;
      return { shown: !!state.current, current_revision: state.current?.revision ?? 0, total_lines: lines.length, content: lines.slice(offset, offset + limit).join('\n'), revisions: revisions(state) };
    }
    case 'restore_canvas_revision': {
      const entry = state.history.find(r => r.revision === input.revision);
      if (!entry) return { shown: false, error: 'Revision not found', revisions: revisions(state) };
      state.current = entry;
      sendFrame({ ...entry, action: 'restore' }, emit);
      return { shown: true, revision: entry.revision, title: entry.title };
    }
    default: return { shown: false, error: 'Unknown canvas tool' };
  }
}

/** Same accumulator, early speech, preview cadence and final execution for live and demo. */
export function streamedTool(state: Canvas, emit: Emit) {
  let args = '', spoken = false, frameAt = -Infinity, lastHtml = '', previewed = false;
  const say = (name: string, value: string) => {
    if (!value.trim() || spoken) return;
    spoken = true;
    emit({ type: name === 'session_thinking_append' ? 'thinking' : 'commentary', content: truncateAppendContent(value).content });
  };
  const appendTool = (name: string) => name === 'session_commentary_append' || name === 'session_thinking_append';
  const canvasTool = (name: string) => name === 'render_canvas_card' || name === 'canvas_edit';
  return {
    push(name: string, delta: string, now = Date.now()) {
      args += delta;
      if (args.length > 400_000) throw new Error('工具参数过长。');
      if (!spoken && (appendTool(name) || canvasTool(name))) {
        const field = extractStreamingStringArg(args, appendTool(name) ? 'content' : 'commentary');
        if (field.closed) say(name, field.value);
      }
      if (!canvasTool(name) || now - frameAt < FRAME_INTERVAL) return;
      const action = name === 'canvas_edit' ? 'edit' : 'write';
      const old = action === 'edit' ? extractStreamingStringArg(args, 'old_string') : undefined;
      const replacement = action === 'edit' ? extractStreamingStringArg(args, 'new_string').value : '';
      const raw = action === 'write' ? extractStreamingHtmlArg(args) : old?.closed && replacement
        ? replaceUnique(state.current?.rawHtml ?? '', old.value, replacement) : undefined;
      if (!raw || raw === lastHtml || raw.length > MAX_HTML) return;
      lastHtml = raw;
      frameAt = now;
      previewed = true;
      const title = extractStreamingStringArg(args, 'title');
      emit({ type: 'canvas_stream', action, ...prepareStreamingPreview(raw), done: false, revision: state.nextRevision + 1, title: title.closed ? title.value.slice(0, 90) : undefined });
    },
    get args() { return args; },
    resetPreview() {
      if (!previewed) return;
      if (state.current) sendFrame(state.current, emit);
      else emit({ type: 'canvas_stream', action: 'write', html: '', styles: '', done: true });
      previewed = false;
    },
    finish(name: string) {
      let input: Input;
      try {
        input = JSON.parse(args);
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid args');
      } catch { this.resetPreview(); return { shown: false, error: 'Invalid tool arguments' }; }
      if (appendTool(name)) {
        say(name, text(input.content));
        return { sent: spoken };
      }
      if (canvasTool(name)) say(name, text(input.commentary));
      const result = executeCanvasTool(state, name, input, emit);
      if (!result.shown) this.resetPreview();
      previewed = false;
      return result;
    },
  };
}
