// Relay visual state, not the editor page. Each subscriber renders the same
// sandboxed #stream-surface; controls, captions and audio never enter OBS.
export function createLiveCanvasRelay() {
  let frame = null;
  const subscribers = new Set();
  function send(res) {
    if (res.writableLength > 2 * 1024 * 1024) { res.destroy(); return; }
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  }
  const heartbeat = setInterval(() => {
    for (const res of subscribers) {
      if (res.writableLength > 2 * 1024 * 1024) res.destroy();
      else res.write(': keepalive\n\n');
    }
  }, 15000);
  heartbeat.unref();
  return {
    publish(input) {
      if (input !== null && (input?.type !== 'canvas_stream' || typeof input.html !== 'string' || typeof input.styles !== 'string' || typeof input.done !== 'boolean')) throw new Error('需要有效的 live-canvas 画面');
      frame = input === null ? null : { type: 'canvas_stream', action: ['write', 'edit', 'restore'].includes(input.action) ? input.action : 'write', html: input.html, styles: input.styles, done: input.done };
      for (const res of subscribers) send(res);
    },
    subscribe(req, res) {
      if (subscribers.size >= 8) throw new Error('画板观看连接过多');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      subscribers.add(res);
      res.on('close', () => subscribers.delete(res));
      send(res);
    },
    close() { clearInterval(heartbeat); for (const res of subscribers) res.destroy(); subscribers.clear(); },
  };
}
