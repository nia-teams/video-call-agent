/** Bound browser/device setup steps and release them when the call ends. */
export function asyncStep<T>(work: Promise<T>, timeoutMs: number, message: string, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (done: () => void) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); done();
    };
    const abort = () => finish(() => reject(signal.reason ?? new DOMException('Call ended', 'AbortError')));
    const timer = setTimeout(() => finish(() => reject(new Error(message))), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    if (signal.aborted) abort();
  });
}
