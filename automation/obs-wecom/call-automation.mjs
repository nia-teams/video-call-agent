/** Platform defaults restore the incoming-call pipeline; each step can be disabled. */
/** @param {{ STUDIO_AUTO_ANSWER?: string }} [env] */
export function cameraSwitchArgs(env = process.env) {
  return ['--watch', '--wecom-only', ...(env.STUDIO_AUTO_ANSWER === '0' ? [] : ['--auto-answer'])];
}

/** @param {{ STUDIO_AUTO_CAPTURE?: string }} [env] */
export function autoCaptureEnabled(env = process.env) {
  return env.STUDIO_AUTO_CAPTURE !== '0';
}
export function cameraSwitchForEvent(event) {
  if (event.event !== 'call_connected' || event.audioVerified !== true || !Number.isSafeInteger(event.windowID) || event.windowID <= 0) return null;
  return ['--select-camera-window', String(event.windowID)];
}

export function isUntitledCallWindow(window) {
  return !window.title && Math.abs(window.width - 360) <= 3 && Math.abs(window.height - 640) <= 3;
}
export function selectCallWindow(windows, preferredID, audioVerified = false) {
  const calls = windows.filter(w => (/^\d{1,3}:\d{2}(:\d{2})?$/.test(w.title || '') || (audioVerified && isUntitledCallWindow(w))) && w.width > 100 && w.height > 100);
  if (preferredID) { const exact = calls.find(w => w.id === preferredID); if (exact) return exact; }
  if (calls.length > 1) throw new Error('存在多个企微通话窗口，已停止自动选择');
  return calls[0] || null;
}
// WeCom 5 / macOS 14 exposes a blank title and no AX controls during video calls.
// CoreAudio input activity corroborates the unique, observed call window; a
// notification sound or arbitrary untitled window alone never starts capture.
export function createAudioCallFallback({ probe, windows, event }) {
  let active = null, sequence = 0, inactive = 0;
  return {
    async poll() {
      const status = await probe();
      const connected = status.processes?.some(p => p.bundle?.startsWith('com.tencent.WeWorkMac') && p.inputActive);
      if (!connected) {
        if (active && ++inactive >= 2) { event({ event: 'call_ended', id: active.id }); active = null; }
        return;
      }
      inactive = 0;
      if (active) return;
      const candidates = (await windows()).filter(isUntitledCallWindow);
      if (candidates.length !== 1) return;
      active = { id: `audio-window-${candidates[0].id}-${++sequence}`, windowID: candidates[0].id };
      event({ event: 'call_connected', ...active, audioVerified: true });
    },
  };
}
/** One capture attempt per connected call; events never dial or hang up. */
export function createCallAutomation({ enabled = false, state, command, changed, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  let generation = 0, ownedWindow = null, currentID = '', disposed = false;
  let queue = Promise.resolve();
  const publish = (phase, message, windowID = ownedWindow) => changed({ id: currentID, phase, message, windowID });
  async function connected(event, ticket) {
    const valid = () => !disposed && ticket === generation;
    try {
      for (let attempt = 0; attempt < 5 && valid(); attempt++) {
        try { await command('recordings/start', { callID: String(event.id) }); break; }
        catch (error) { if (attempt === 4) publish('error', `自动录音启动失败：${error.message}`); else await sleep(300); }
      }
      if (!valid()) return;
      publish('capturing', '已接通，正在自动读取企微通话窗口');
      let selected = null;
      for (let attempt = 0; attempt < 10 && valid(); attempt++) {
        const windows = await command('windows');
        if (!valid()) return;
        selected = selectCallWindow(windows, event.windowID, event.audioVerified === true);
        if (selected) break;
        await sleep(1000);
      }
      if (!valid()) return;
      if (!selected) throw new Error('未找到可唯一确认的企微通话窗口，请在网页手动选择');
      ownedWindow = selected.id;
      const before = await state(); if (!valid()) return;
      if (before.capture.windowID !== ownedWindow || !before.capture.running) {
        await command('capture/start', { windowID: ownedWindow });
      }
      for (let attempt = 0; attempt < 30 && valid(); attempt++) {
        const current = await state(); if (!valid()) return;
        if (current.capture.running && current.capture.windowID === ownedWindow && current.lastVideo > 0) {
          publish('ready', '企微画面与音频已就绪，等待网页中选定的语音模型连接'); return;
        }
        if (current.capture.error) throw new Error(current.capture.error);
        await sleep(1000);
      }
      if (valid()) throw new Error('等待企微采集就绪超时，请检查屏幕与系统音频录制权限');
    } catch (error) { if (valid()) publish('error', error.message); }
  }
  async function ended(ticket, windowID, callID) {
    try {
      try { await command('recordings/stop', { callID }); } catch { /* Capture cleanup must still run if recording fails. */ }
      const current = await state();
      if (!disposed && ticket === generation && windowID && current.capture.windowID === windowID) await command('capture/stop');
    } catch { /* Server shutdown also releases its capture process. */ }
  }
  return {
    event(event) {
      if (!enabled || disposed) return queue;
      if (event.event === 'call_connected') {
        if (!event.id || event.id === currentID) return queue;
        currentID = String(event.id); const ticket = ++generation;
        queue = queue.then(() => connected(event, ticket)); return queue;
      }
      if (event.event === 'call_ended' && (!event.id || event.id === currentID)) {
        const ticket = ++generation, windowID = ownedWindow, callID = currentID;
        publish('ended', '企微通话已结束，停止自动转接'); ownedWindow = null;
        queue = queue.then(() => ended(ticket, windowID, callID)); return queue;
      }
      return queue;
    },
    close() { disposed = true; generation++; },
  };
}
