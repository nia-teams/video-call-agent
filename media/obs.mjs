import { studioBase } from '../env.mjs';
import OBSWebSocket from 'obs-websocket-js/json';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export class ObsControlError extends Error {}
export function localObsURL(value) {
  const url = new URL(value);
  if (!['ws:', 'wss:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new ObsControlError('OBS WebSocket 必须使用本机回环地址');
  return url.href;
}
export async function obsConnection({ env = process.env } = {}) {
  if (!env.OBS_WEBSOCKET_URL || !env.OBS_WEBSOCKET_PASSWORD) throw new ObsControlError('请在 .env 中填写 OBS_WEBSOCKET_URL 和 OBS_WEBSOCKET_PASSWORD，并开启 OBS WebSocket 密码认证');
  return { url: localObsURL(env.OBS_WEBSOCKET_URL), password: env.OBS_WEBSOCKET_PASSWORD };
}
async function bounded(operation, milliseconds, message) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new ObsControlError(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
export async function withOBS(action, { connection, client = new OBSWebSocket(), timeout = 6000 } = {}) {
  const settings = connection || await obsConnection();
  localObsURL(settings.url);
  // Never emit the SDK's connection error object: it can contain connection data.
  client.on('ConnectionError', () => {});
  try {
    try { await bounded(client.connect(settings.url, settings.password, { rpcVersion: 1, eventSubscriptions: 0 }), timeout, '连接 OBS WebSocket 超时'); }
    catch (error) { if (error instanceof ObsControlError) throw error; throw new ObsControlError(error?.code === 4009 ? 'OBS WebSocket 密码认证失败' : '无法连接 OBS WebSocket，请检查服务开关、端口和密码'); }
    const call = async (type, data) => {
      try { return await bounded(client.call(type, data), timeout, `OBS ${type} 请求超时`); }
      catch (error) { if (error instanceof ObsControlError) throw error; throw new ObsControlError(`OBS ${type} 请求失败${Number.isInteger(error?.code) ? `（${error.code}）` : ''}`); }
    };
    return await action(call);
  } finally { try { await bounded(client.disconnect(), 1000, 'OBS 连接关闭超时'); } catch {} }
}
export async function obsStatus(options) {
  return withOBS(async call => {
    const [version, camera, scenes] = await Promise.all([call('GetVersion'), call('GetVirtualCamStatus'), call('GetSceneList')]);
    return { connected: true, obsVersion: version.obsVersion, websocketVersion: version.obsWebSocketVersion, virtualCameraActive: camera.outputActive, sceneName: scenes.currentProgramSceneName };
  }, options);
}
export const PHONE_VIDEO = { baseWidth: 1080, baseHeight: 1920, outputWidth: 1080, outputHeight: 1920 };
export async function ensurePortraitVideo(call) {
  const current = await call('GetVideoSettings');
  if (Object.entries(PHONE_VIDEO).every(([key, value]) => current[key] === value)) return;
  const stream = await call('GetStreamStatus');
  const record = await call('GetRecordStatus');
  if (stream.outputActive || record.outputActive) throw new ObsControlError('OBS 正在直播或录制，请结束后再切换竖屏画布');
  const camera = await call('GetVirtualCamStatus');
  // OBS cannot reset its video subsystem while the virtual camera is active.
  if (camera.outputActive) await call('StopVirtualCam');
  async function settle(type, data) {
    for (let attempt = 0; ; attempt++) {
      try { return await call(type, data); }
      catch (error) {
        if (attempt >= 7) throw error;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  }
  try { await settle('SetVideoSettings', PHONE_VIDEO); }
  finally { if (camera.outputActive) await call('StartVirtualCam'); }
}
export async function ensurePlatformSource(call, outputURL = `${studioBase()}/studio/output`) {
  const url = new URL(outputURL);
  if (url.protocol !== 'http:' || !['127.0.0.1','localhost'].includes(url.hostname) || url.pathname !== '/studio/output' || url.username || url.password || url.search || url.hash) throw new ObsControlError('OBS 浏览器源必须使用本机平台输出页');
  let { currentProgramSceneName: sceneName } = await call('GetSceneList');
  if (!sceneName) {
    sceneName = '企微转接';
    await call('CreateScene', { sceneName });
    await call('SetCurrentProgramScene', { sceneName });
  }
  const { sceneItems } = await call('GetSceneItemList', { sceneName });
  const { baseWidth, baseHeight } = await call('GetVideoSettings');
  async function fit(inputName, sceneItemId, sceneItemIndex) {
    await call('SetInputSettings', { inputName, inputSettings: { width: baseWidth, height: baseHeight, shutdown: false, restart_when_active: false, reroute_audio: false }, overlay: true });
    await call('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: true });
    await call('SetSceneItemTransform', { sceneName, sceneItemId, sceneItemTransform: { positionX: 0, positionY: 0, rotation: 0, scaleX: 1, scaleY: 1, alignment: 5, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: baseWidth, boundsHeight: baseHeight } });
    await call('SetSceneItemIndex', { sceneName, sceneItemId, sceneItemIndex });
  }
  for (const item of sceneItems) {
    if (item.inputKind !== 'browser_source') continue;
    const { inputSettings } = await call('GetInputSettings', { inputName: item.sourceName });
    if (inputSettings.url === outputURL) {
      await fit(item.sourceName, item.sceneItemId, sceneItems.length - 1);
      return { sceneName, inputName: item.sourceName, reused: true };
    }
  }
  const { inputs } = await call('GetInputList');
  const names = new Set(inputs.map(input => input.inputName));
  let inputName = 'WeCom 平台输出';
  for (let suffix = 2; names.has(inputName); suffix++) inputName = `WeCom 平台输出 ${suffix}`;
  const { sceneItemId } = await call('CreateInput', { sceneName, inputName, inputKind: 'browser_source', inputSettings: { url: outputURL, width: baseWidth, height: baseHeight, shutdown: false, reroute_audio: false }, sceneItemEnabled: true });
  await fit(inputName, sceneItemId, sceneItems.length);
  return { sceneName, inputName, reused: false };
}
export async function ensureAvatarClarity(call, sourceName) {
  const filterName = '数字人清晰度';
  const { filters = [] } = await call('GetSourceFilterList', { sourceName });
  // Preserve existing user filters; only maintain our own mild sharpening.
  if (filters.some(filter => filter.filterName === filterName)) return;
  const { sourceFilterKinds = [] } = await call('GetSourceFilterKindList');
  if (sourceFilterKinds.includes('sharpness_filter_v2')) {
    await call('CreateSourceFilter', { sourceName, filterName, filterKind: 'sharpness_filter_v2', filterSettings: { sharpness: 0.10 } });
  }
}
export async function prepareOBS({ configureSource = false, refreshSource = false, outputURL, ...options } = {}) {
  return withOBS(async call => {
    if (configureSource) await ensurePortraitVideo(call);
    const source = configureSource ? await ensurePlatformSource(call, outputURL) : undefined;
    if (source) await ensureAvatarClarity(call, source.inputName);
    if (source && refreshSource) await call('PressInputPropertiesButton', { inputName: source.inputName, propertyName: 'refreshnocache' });
    let camera = await call('GetVirtualCamStatus');
    if (!camera.outputActive) { await call('StartVirtualCam'); camera = await call('GetVirtualCamStatus'); }
    if (!camera.outputActive) throw new ObsControlError('OBS 未确认虚拟摄像头启动，请检查 OBS 的扩展授权或签名错误；本次不再自动重试');
    return { connected: true, virtualCameraActive: true, ...(source ? { source } : {}) };
  }, options);
}
export async function launchAndPrepareOBS({ openOBS = () => promisify(execFile)('/usr/bin/open', ['-g', '-a', '/Applications/OBS.app']), ...options } = {}) {
  // Open OBS even if its API settings still require user attention.
  await openOBS();
  const connection = options.connection || await obsConnection();
  const deadline = Date.now() + 20000;
  let lastError, ready = false;
  while (Date.now() < deadline) {
    // Retry only a read-only readiness probe. Repeating StartVirtualCam when
    // macOS rejects its extension produces a new system error dialog each time.
    try { await withOBS(call => call('GetVersion'), { ...options, connection, timeout: 2500 }); ready = true; break; }
    catch (error) { lastError = error; if (error.message.includes('密码认证')) throw error; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!ready) throw lastError || new ObsControlError('OBS 启动超时');
  // Once the API is ready, configuration and camera activation run once.
  return prepareOBS({ ...options, connection, timeout: 2500 });
}
