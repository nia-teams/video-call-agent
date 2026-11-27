const encoder = new TextEncoder()
export const MAX_APPEND_CONTENT_BYTES = 1500
export function truncateAppendContent(
  text: string,
  maxBytes = MAX_APPEND_CONTENT_BYTES,
): { content: string; truncated: boolean; originalBytes: number } {
  const originalBytes = encoder.encode(text).length
  if (originalBytes <= maxBytes) {
    return { content: text, truncated: false, originalBytes }
  }
  let out = ''
  let bytes = 0
  for (const char of text) {
    const charBytes = encoder.encode(char).length
    if (bytes + charBytes > maxBytes) break
    out += char
    bytes += charBytes
  }
  return { content: out, truncated: true, originalBytes }
}

export type Transcript = { seq: number; role: 'user' | 'assistant'; text: string };
export type CanvasFrame = {
  type: 'canvas_stream'; action: 'write' | 'edit' | 'restore'; html: string; styles: string;
  done: boolean; revision?: number; title?: string;
};
export type StreamEvent = CanvasFrame | { type: 'commentary' | 'thinking' | 'error' | 'demo_session'; content: string };
