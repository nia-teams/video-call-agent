'use client';
import { useEffect, useRef, useState } from 'react';
import type { CanvasFrame } from '../../lib/live-canvas/protocol';
import { studioHeaders } from '../studio/media';

// Serialize and coalesce updates so a slow request cannot overwrite a newer
// streamed preview. The source revision fences packets from closed editors.
export function useCanvasPublisher(frame: CanvasFrame | null, sourceRevision: number) {
  const [error, setError] = useState('');
  const pending = useRef<{ frame: CanvasFrame | null } | null>(null);
  const wake = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!sourceRevision) return;
    const controller = new AbortController();
    let running = false, switched = false;
    async function flush() {
      if (running || switched || controller.signal.aborted) return;
      running = true;
      try {
        while (pending.current && !controller.signal.aborted) {
          const next = pending.current;
          pending.current = null;
          try {
            const response = await fetch('/bridge/live-canvas', {
              method: 'POST', headers: await studioHeaders('application/json'), signal: controller.signal,
              body: JSON.stringify({ sourceRevision, frame: next.frame }),
            });
            if (!response.ok) {
              switched = response.status === 409;
              throw new Error((await response.json()).error || '画板发送失败');
            }
            setError('');
          } catch (cause) {
            if (!controller.signal.aborted) {
              setError(cause instanceof Error ? cause.message : '画板发送失败');
              // Retry the latest visual state after a temporary disconnect.
              if (!switched) pending.current ??= next;
            }
            break;
          }
        }
      } finally { running = false; }
    }
    wake.current = () => { void flush(); };
    const retry = setInterval(() => { if (pending.current) void flush(); }, 2000);
    return () => { controller.abort(); clearInterval(retry); wake.current = null; pending.current = null; };
  }, [sourceRevision]);
  useEffect(() => { pending.current = { frame }; wake.current?.(); }, [frame, sourceRevision]);
  return error;
}
