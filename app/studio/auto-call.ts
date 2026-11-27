/** Share only a random call ID, never credentials or media, across local tabs. */
export async function claimAutoCall(id: string, options: { storage?: Pick<Storage, 'getItem'|'setItem'>; provider?: 'qwen'|'live-canvas'; locks?: Pick<LockManager, 'request'> } = {}) {
  if (!id) return false;
  const storage=options.storage ?? window.localStorage;
  const locks=options.locks ?? navigator.locks;
  if (!locks) throw new Error('当前浏览器不支持自动转接协调，请手动点击预览');
  const provider = options.provider ?? 'qwen';
  const key = `wecom-${provider}:auto-call:v1`;
  return locks.request(`wecom-${provider}-auto-call`, {mode:'exclusive'}, () => {
    if (storage.getItem(key)===id) return false;
    storage.setItem(key,id);return true;
  });
}
