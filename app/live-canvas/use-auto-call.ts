import { useEffect, useEffectEvent, useRef } from 'react';
import type { StudioState } from '../studio/media';

// startLive acquires the shared, held provider Web Lock before contacting GPT.
// A permanent localStorage claim can strand an interrupted startup or reload.
const claimLiveCall = async (_id: string) => true;
type Options = {
  sourceRevision: number; outputReady: boolean; busy: boolean; source: string;
  start: () => void; stop: () => void; onError: (message: string) => void;
  claim?: (id: string) => Promise<boolean>;
};
export function useLiveCanvasAutoCall(studio: StudioState | null, options: Options) {
  const attempted = useRef(''), owner = useRef(''), ended = useRef('');
  const start = useEffectEvent(options.start), stop = useEffectEvent(options.stop), onError = useEffectEvent(options.onError);
  const claim = options.claim ?? claimLiveCall;
  const id = studio?.autoCall?.id, phase = studio?.autoCall?.phase, windowID = studio?.autoCall?.windowID;
  const running = studio?.capture.running, captureWindowID = studio?.capture.windowID;
  const selected = studio?.source.kind === 'live-canvas' && studio.source.revision === options.sourceRevision;
  useEffect(() => {
    if (id && phase === 'ended' && ended.current !== id) {
      ended.current = id; owner.current = ''; stop(); return;
    }
    if (owner.current && (owner.current !== id || !running || captureWindowID !== windowID || !selected || !options.outputReady)) {
      owner.current = ''; stop(); return;
    }
    if (!selected || phase !== 'ready' || !id || attempted.current === id || !running || captureWindowID !== windowID || !options.outputReady) return;
    if (options.busy) {
      // Replace a local test/demo with the actual remote conversation.
      if (options.source !== 'wecom') stop();
      else owner.current = id;
      return;
    }
    let cancelled = false;
    void claim(id).then(claimed => {
      if (cancelled) return;
      attempted.current = id;
      if (!claimed) return;
      owner.current = id; start();
    }).catch(() => {
      if (!cancelled) { attempted.current = id; onError('浏览器无法协调 Live Canvas 自动通话，请手动开始语音通话'); }
    });
    return () => { cancelled = true; };
  }, [id, phase, windowID, running, captureWindowID, selected, options.outputReady, options.busy, options.source, claim]);
}
