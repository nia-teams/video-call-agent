'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { CanvasFrame } from '../../../lib/live-canvas/protocol';
import { hostHtml } from './canvasHost';

export function CanvasStage({ frame, onInteract }: { frame: CanvasFrame | null; onInteract: (text: string) => void }) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const send = useCallback(() => {
    iframe.current?.contentWindow?.postMessage({
      type: 'her-canvas-update', payload: frame ?? { html: '', styles: '', done: false },
    }, '*'); // sandbox without allow-same-origin has an opaque origin
  }, [frame]);
  useEffect(send, [send]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== iframe.current?.contentWindow || event.origin !== 'null' || event.data?.type !== 'her-canvas-interact') return;
      const text = typeof event.data.text === 'string' ? event.data.text.trim().slice(0, 400) : '';
      if (text) onInteract(text);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [onInteract]);
  return <iframe style={{ display: 'block', width: '100%', height: '100%', border: 0 }} ref={iframe} title="HeR 画板" srcDoc={hostHtml} sandbox="allow-scripts" onLoad={send} />;
}
