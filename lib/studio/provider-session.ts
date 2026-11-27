/** Origin-wide connection ownership, independent of the optional avatar lease.
 * Web Locks also covers other studio tabs. Fail closed
 * if unavailable; never start an upstream session without owning the lock. */
export function acquireProviderSession(signal?: AbortSignal): Promise<() => void> {
  if (!navigator.locks) return Promise.reject(new Error('当前浏览器不支持通话互斥，请使用新版 Chrome'));
  return new Promise((resolve, reject) => {
    void navigator.locks.request('wecom-studio-ai-provider', { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (signal?.aborted) { reject(new DOMException('aborted', 'AbortError')); return; }
      if (!lock) { reject(new Error('另一个 AI 会话正在连接或通话，请先断开')); return; }
      await new Promise<void>(release => {
        let released = false;
        resolve(() => { if (!released) { released = true; release(); } });
      });
    }).catch(reject);
  });
}
