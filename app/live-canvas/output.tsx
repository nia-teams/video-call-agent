'use client';
import { useEffect, useRef, useState } from 'react';
import { CanvasStage } from './components/CanvasStage';
import type { CanvasFrame } from '../../lib/live-canvas/protocol';
const ignoreInteraction = () => {};
export default function LiveCanvasOutput() {
  const container = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 400, height: 711 });
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width && height) setSize({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Keep HTML typography at phone scale even in the 1080px OBS source.
  const scale = size.width / 400;
  const [frame, setFrame] = useState<CanvasFrame | null>(null);
  useEffect(() => {
    const events = new EventSource('/bridge/live-canvas/events');
    events.onmessage = event => setFrame(JSON.parse(event.data));
    return () => events.close();
  }, []);
  return <div ref={container} style={{ width: '100%', height: '100%', overflow: 'hidden', background: 'linear-gradient(155deg,#FAF8F5 5%,#FFE8D6 100%)', pointerEvents: 'none' }}>
    <div style={{ width: 400, height: size.height / scale, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
      <CanvasStage frame={frame} onInteract={ignoreInteraction}/>
    </div>
  </div>;
}
