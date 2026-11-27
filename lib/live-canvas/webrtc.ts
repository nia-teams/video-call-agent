export function waitForIce(peer: RTCPeerConnection, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    function cleanup() {
      clearTimeout(timer);
      peer.removeEventListener('icegatheringstatechange', change);
      signal.removeEventListener('abort', abort);
    }
    function abort() { cleanup(); reject(signal.reason); }
    function change() { if (peer.iceGatheringState === 'complete') { cleanup(); resolve(); } }
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('ICE 候选收集超时，请检查网络后重试。'));
    }, 8_000);
    peer.addEventListener('icegatheringstatechange', change);
    signal.addEventListener('abort', abort, { once: true });
    change();
  });
}
