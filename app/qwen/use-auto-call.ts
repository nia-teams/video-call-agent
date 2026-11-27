import { useEffect, useEffectEvent, useRef } from 'react';
import { claimAutoCall } from '../studio/auto-call';
import type { StudioState } from '../studio/media';

type Options = {
  outputReady: boolean;
  busy: boolean;
  source: string;
  start: () => void;
  stop: () => void;
  onError: (message: string) => void;
  claim?: (id: string) => Promise<boolean>;
};
const claimQwenCall = (id: string) => claimAutoCall(id, { provider: 'qwen' });

export function useQwenAutoCall(studio: StudioState | null | undefined, options: Options) {
  const attempted = useRef(''), owner = useRef(''), ended = useRef('');
  const start = useEffectEvent(options.start), stop = useEffectEvent(options.stop);
  const onError = useEffectEvent(options.onError);
  const claim = options.claim ?? claimQwenCall;
  const event = studio?.autoCall;
  const id = event?.id, phase = event?.phase, windowID = event?.windowID;
  const running = studio?.capture.running, captureWindowID = studio?.capture.windowID;
  useEffect(() => {
    if (phase === 'ended' && id && ended.current !== id) {
      ended.current = id; owner.current = ''; stop(); return;
    }
    if (owner.current && (owner.current !== id || !running)) {
      owner.current = ''; stop(); return;
    }
    if (phase !== 'ready' || !id || attempted.current === id || !running || captureWindowID !== windowID || !options.outputReady) return;
    if (options.busy) {
      // A connected WeCom call replaces a local microphone test.
      if (options.source === 'microphone') stop();
      return;
    }
    attempted.current = id;
    let cancelled = false;
    void claim(id).then(claimed => {
      if (cancelled || !claimed) return;
      owner.current = id; start();
    }).catch(() => { if (!cancelled) onError('浏览器无法协调千问自动连接，请手动连接 Qwen'); });
    return () => { cancelled = true; };
  }, [id, phase, windowID, running, captureWindowID, options.outputReady, options.busy, options.source, claim]);
}
