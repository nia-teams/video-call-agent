'use client';
import { useEffect, useRef, useState } from 'react';
import { asyncStep } from '../../lib/studio/async-step';
import { acquireProviderSession } from '../../lib/studio/provider-session';
import { createAvatarPublisher } from '../../lib/studio/avatar-publisher';
import { isExplicitDevice, isVirtualInput, isVirtualOutput } from '../studio/audio-devices';
import '../studio/studio.scss';
import { AnalyserMeter, IncomingMeter } from '../studio/levels';
import type { StudioState } from '../studio/media';
import { qwenOutput } from './audio-devices';
import { useQwenAutoCall } from './use-auto-call';

type Diagnostics = {
  phase: 'connecting' | 'ready' | 'failed' | 'closed';
  videoFrames: number; videoBytes: number; videoSkipped: number;
  inputPackets: number; inputBytes: number; inputRms: number;
  speechStarted: number; speechStopped: number; committed: number;
  responseRequested: number; responseCreated: number; audioBytes: number; responseDone: number;
};
type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };
export default function QwenPanel({ studioState }: { studioState?: StudioState | null } = {}) {
  const [source, setSource] = useState('wecom'), [sink, setSink] = useState('');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [input, setInput] = useState(''), [trackInfo, setTrackInfo] = useState('');
  const inputs = devices.filter(d => d.kind === 'audioinput' && isExplicitDevice(d) && !!d.label && !isVirtualInput(d.label));
  const [status, setStatus] = useState('未连接'), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [output, setOutput] = useState({ packets: 0, bytes: 0, queuedMs: 0 });
  const inputAnalyser = useRef<AnalyserNode | null>(null), outputAnalyser = useRef<AnalyserNode | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  useEffect(() => {
    let disposed = false;
    const mediaDevices = navigator.mediaDevices;
    const update = async () => {
      try {
        const next = await mediaDevices.enumerateDevices();
        if (disposed) return;
        setDevices(next); setSink(current => qwenOutput(next, current));
      } catch { /* The refresh button can request device-name permission. */ }
    };
    void update(); mediaDevices.addEventListener('devicechange', update);
    return () => { disposed = true; mediaDevices.removeEventListener('devicechange', update); };
  }, []);
  useQwenAutoCall(studioState, {
    outputReady: !!sink && devices.some(d => d.deviceId === sink && isVirtualOutput(d.label)),
    busy, source,
    start: () => { setSource('wecom'); void start('wecom'); },
    stop: () => cleanup.current?.(), onError: setError,
  });
  async function refresh() {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); stream.getTracks().forEach(t => t.stop());
      const next = await navigator.mediaDevices.enumerateDevices();
      setDevices(next); setSink(current => qwenOutput(next, current));
      const candidates = next.filter(d => d.kind === 'audioinput' && isExplicitDevice(d) && !!d.label && !isVirtualInput(d.label));
      if (input && !candidates.some(d => d.deviceId === input)) {
        setInput(''); setError('所选麦克风已不可用，请重新选择。');
      } else if (source === 'microphone' && !candidates.length) {
        setError('未发现可选实体麦克风，请连接内置、USB 或耳机麦克风后刷新；Node Virtual Mic / BlackHole 不能用于本机麦克风测试。');
      }
    } catch { setError('无法读取音频设备，请检查麦克风权限'); }
  }
  async function start(sessionSource = source) {
    if (cleanup.current) return;
    setBusy(true); setError(''); setTrackInfo(''); setStatus('正在初始化（输出设备 / 采集 / HeR / 服务连接）…'); setDiagnostics(null); setOutput({ packets: 0, bytes: 0, queuedMs: 0 });
    let context: SinkContext | undefined, mic: MediaStream | undefined, socket: WebSocket | undefined;
    let publisher: ReturnType<typeof createAvatarPublisher> | undefined, worklet: AudioWorkletNode | undefined;
    let releaseProvider: (() => void) | undefined;
    let closed = false, until = 0, ready = false;
    const initialization = new AbortController();
    let scheduledPackets = 0, scheduledBytes = 0;
    const reportTrack = () => {
      const track = mic?.getAudioTracks()[0];
      if (!track) return;
      const settings = track.getSettings();
      // Never expose deviceId/groupId or the raw settings object.
      setTrackInfo(`${track.label || '未命名麦克风'} · muted=${track.muted} · enabled=${track.enabled} · ${track.readyState} · ${settings.sampleRate ?? '?'} Hz / ${settings.channelCount ?? '?'} 声道 · 回声消除=${settings.echoCancellation ?? '?'} · 降噪=${settings.noiseSuppression ?? '?'}`);
    };
    const reportOutput = () => { reportTrack(); setOutput({ packets: scheduledPackets, bytes: scheduledBytes,
      queuedMs: context && !closed ? Math.max(0, Math.round((until - context.currentTime) * 1000)) : 0 }); };
    const diagnosticTimer = setInterval(reportOutput, 1000);
    const nodes = new Set<AudioBufferSourceNode>(), timers = new Set<ReturnType<typeof setTimeout>>();
    const clear = () => {
      for (const n of nodes) { n.stop(); n.disconnect(); } nodes.clear();
      for (const t of timers) clearTimeout(t); timers.clear(); until = 0;
      if (!closed && publisher) {
        // Clear confirmation is a Qwen call gate, not a rate-limited warning.
        const failed = () => fail('HeR 口型清空未确认，已停止 Qwen 通话');
        void publisher.clear().then(cleared => { if (!cleared) failed(); }, failed);
      }
    };
    const stop = () => {
      if (closed) return; closed = true; initialization.abort(); clearInterval(diagnosticTimer); clear(); socket?.close(); worklet?.disconnect(); mic?.getTracks().forEach(t => { t.onended = null; t.onmute = null; t.onunmute = null; t.stop(); }); reportOutput();
      inputAnalyser.current?.disconnect(); outputAnalyser.current?.disconnect();
      inputAnalyser.current = null; outputAnalyser.current = null;
      publisher?.close(); void context?.close();
      // Keep ownership until the local Qwen WebSocket has closed.
      if (!socket) releaseProvider?.();
      cleanup.current = null; setBusy(false); setStatus('已断开');
    };
    const fail = (message: string) => { if (!closed) {
      stop();
      const reasons: Record<string, string> = {
        'Start WeCom capture first': '尚未启动企微音频采集，请先启动采集。',
        'Qwen input stopped': '输入音频已停止超过 5 秒或企微采集已结束。',
        'Qwen session configuration not confirmed': '服务未确认要求的音频 / VAD 配置，已停止。',
        'Qwen connection failed': '无法连接 Qwen 服务，请检查网络与服务配置。',
        'Qwen connection closed': 'Qwen 服务连接已关闭，不会自动重连。',
        'Qwen provider rejected the session': 'Qwen 服务拒绝会话，请检查配置、权限与配额。',
        'Qwen initialization timed out': 'Qwen 服务初始化超时，未开始发送音频。',
      };
      setError(reasons[message] || (/[\u3400-\u9fff]/.test(message) ? message : 'Qwen 会话异常，已停止。请检查服务配置、输入采集和网络后手动重试。'));
    } };
    cleanup.current = stop;
    try {
      if (!sink || !isVirtualOutput(devices.find(d => d.deviceId === sink)?.label || '')) throw new Error('请选择虚拟话筒输出设备');
      context = new AudioContext();
      if (!context.setSinkId) throw new Error('请使用支持输出设备选择的新版 Chrome');
      setStatus('正在准备虚拟音频输出…');
      await asyncStep(context.setSinkId(sink), 4000, '虚拟音频输出准备超时，请检查 Node Audio Send 或 BlackHole 后重试', initialization.signal);
      if (closed) return;
      setStatus('正在启用浏览器音频…');
      await asyncStep(context.resume(), 4000, '浏览器尚未允许自动音频，请点击“连接 Qwen”启用', initialization.signal);
      if (closed) return;
      const playbackAnalyser = context.createAnalyser(); playbackAnalyser.fftSize = 2048;
      playbackAnalyser.connect(context.destination); outputAnalyser.current = playbackAnalyser;
      if (sessionSource === 'microphone') {
        if (!input) throw new Error('请先授权并刷新设备，再明确选择实体麦克风；不会使用系统默认输入。');
        const current = await navigator.mediaDevices.enumerateDevices();
        if (closed) return;
        setDevices(current);
        const selected = current.find(d => d.kind === 'audioinput' && d.deviceId === input && isExplicitDevice(d));
        if (!selected) throw new Error('所选麦克风已断开或不可用，请刷新并重新选择。');
        if (!selected.label || isVirtualInput(selected.label)) throw new Error('请选择实体麦克风；Node Virtual Mic / BlackHole 不能用于本机麦克风测试。');
        try {
          mic = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: input }, echoCancellation: true, noiseSuppression: true }, video: false });
        } catch (e) {
          const name = e && typeof e === 'object' && 'name' in e ? e.name : '';
          throw new Error(name === 'OverconstrainedError' || name === 'NotFoundError'
            ? '所选麦克风已断开或不可用，请刷新并重新选择。'
            : '无法打开所选麦克风，请检查权限、设备占用和连接后重试。');
        }
        if (closed) { mic.getTracks().forEach(t => t.stop()); return; }
        const track = mic.getAudioTracks()[0];
        if (!track || isVirtualInput(track.label)) throw new Error('实际输入不是可用实体麦克风，已停止；请刷新并重新选择。');
        reportTrack(); track.onmute = reportTrack; track.onunmute = reportTrack;
        await context.audioWorklet.addModule('/qwen-input.js');
        if (closed) return;
        worklet = new AudioWorkletNode(context, 'qwen-input');
        const microphoneSource = context.createMediaStreamSource(mic);
        const microphoneAnalyser = context.createAnalyser(); microphoneAnalyser.fftSize = 2048;
        microphoneSource.connect(microphoneAnalyser); inputAnalyser.current = microphoneAnalyser;
        microphoneSource.connect(worklet);
        // Worklet output is silence; never monitor the microphone into WeCom.
        worklet.connect(context.destination);
        mic.getAudioTracks()[0].onended = () => fail('麦克风已停止');
        worklet.port.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => {
          if (!ready || closed || socket?.readyState !== WebSocket.OPEN) return;
          if (socket.bufferedAmount > 64000) return fail('麦克风发送积压，已停止');
          socket.send(data);
        };
      }
      setStatus('正在检查企微采集状态…');
      const state = await asyncStep(fetch('/bridge/state', { cache: 'no-store', signal: initialization.signal }), 5000, '本机状态请求超时，请关闭重复的媒体控制台标签页后重试', initialization.signal).then(r => { if (!r.ok) throw new Error('媒体服务未连接'); return r.json(); });
      if (closed) return;
      if (sessionSource === 'wecom' && !state.capture?.running) throw new Error('请先启动企微窗口与音频采集');
      if (state.autoAudio?.active && ['file', 'url'].includes(state.source?.kind)) throw new Error('请先停止视频声音输出');
      releaseProvider = await acquireProviderSession();
      if (closed) { releaseProvider(); return; }
      if (state.avatar?.active) throw new Error('人物输出仍在释放，请稍后重试');
      publisher = createAvatarPublisher(() => fail('HeR 口型连接中断，已停止 Qwen 通话'), 'Qwen');
      if (!await publisher.start()) throw new Error('无法启动 HeR 口型');
      if (closed) return;
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/bridge/qwen`);
      socket.addEventListener('close', () => releaseProvider?.(), { once: true });
      socket.onopen = () => socket?.send(JSON.stringify({ token: state.csrfToken, source: sessionSource }));
      socket.onerror = () => fail('Qwen 本地连接失败');
      socket.onclose = () => { if (!closed) fail('Qwen 连接已结束；不会自动重连'); };
      socket.onmessage = ({ data }) => {
        if (closed) return;
        try {
          const event = JSON.parse(data);
          if (event.type === 'diagnostics') { setDiagnostics(event as Diagnostics); return; }
          if (event.type === 'error') return fail(event.message);
          if (event.type === 'ready') { ready = true; setStatus('已连接 · PCM16k → Qwen → PCM24k → 虚拟话筒 / HeR'); return; }
          if (event.type === 'clear') { clear(); return; }
          if (event.type !== 'audio' || !ready || !context) return;
          if (context.state !== 'running') return fail('音频播放已暂停，已停止会话');
          const bytes = Uint8Array.from(atob(event.pcm), c => c.charCodeAt(0)), view = new DataView(bytes.buffer);
          if (!bytes.length || bytes.length % 2 || bytes.length > 4800) throw new Error('invalid pcm');
          const samples = new Float32Array(bytes.length / 2);
          for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
          // Qwen can synthesize faster than real time. Queue a normal reply
          // without disconnecting after its first second; interruption still
          // stops every scheduled node immediately. Keep a hard memory bound.
          if (Math.max(until, context.currentTime) + samples.length / 24000 > context.currentTime + 30) return fail('千问回复缓存超过 30 秒，已停止会话，请重新连接');
          const buffer = context.createBuffer(1, samples.length, 24000); buffer.copyToChannel(samples, 0);
          const node = context.createBufferSource(); node.buffer = buffer; node.connect(playbackAnalyser); nodes.add(node);
          node.onended = () => { nodes.delete(node); node.disconnect(); };
          until = Math.max(until, context.currentTime + 0.02); node.start(until);
          scheduledPackets++; scheduledBytes += bytes.length;
          const mouthGeneration = publisher?.generation();
          const timer = setTimeout(() => { timers.delete(timer); if (!closed) publisher?.samples([samples], 24000, mouthGeneration); }, Math.max(0, (until - context.currentTime) * 1000));
          timers.add(timer); until += buffer.duration;
        } catch { fail('Qwen 音频格式异常，已停止'); }
      };
    } catch (e) { fail(e instanceof Error ? e.message : 'Qwen 初始化失败'); }
  }
  return <section className="studio-card">
    <div className="studio-title"><span>QWEN OMNI / 实时语音</span><b>本机服务直连实时语音端点 · HeR / OBS / 虚拟话筒复用</b></div>
    <p>选中千问后，企微通话接通并完成采集时自动连接，挂断自动断开。自动连接使用企微通话音视频；本机麦克风测试可手动连接。</p>
    <p>切换模型会断开旧连接；同源其他标签页的 AI 通话互斥。企微模式只转发采集到的通话声音；麦克风模式用于本机测试。企微模式同时把采集窗口画面以每秒一帧发送给千问；麦克风模式只发送语音。</p>
    <div className="studio-controls">
      <select aria-label="Qwen 音频输入" disabled={busy} value={source} onChange={e => setSource(e.target.value)}><option value="wecom">企微通话音视频（对方）</option><option value="microphone">本机麦克风（本地说话测试）</option></select>
      <button type="button" className="qwen-refresh-devices" aria-label="授权并刷新音频设备" title="授权并刷新音频设备" disabled={busy} onClick={() => void refresh()}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 17.9 17"/></svg></button>
      {source === 'microphone' ? <select aria-label="Qwen 本机麦克风" disabled={busy} value={input} onChange={e => setInput(e.target.value)}><option value="">明确选择内置 / USB / 耳机麦克风</option>{inputs.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}</select> : null}
      <select aria-label="Qwen 虚拟话筒输出" disabled={busy} value={sink} onChange={e => setSink(e.target.value)}><option value="">选择 Node Audio Send / BlackHole</option>{devices.filter(d => d.kind === 'audiooutput' && isExplicitDevice(d) && isVirtualOutput(d.label)).map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}</select>
      <button disabled={busy} onClick={() => void start()}>连接 Qwen</button><button disabled={!busy} onClick={() => cleanup.current?.()}>断开 Qwen</button>
    </div>
    {source === 'microphone' ? <p>本机测试不会使用系统默认输入；请先授权并刷新，再选择实体麦克风。已排除 Node Virtual Mic / BlackHole 回送输入。{!inputs.length ? ' 当前没有可选实体麦克风，请检查连接和权限后刷新。' : ''}</p> : null}
    {source === 'wecom' ? <p>当前输入为企微播放的对方声音和通话窗口画面。本机对着麦克风说话不会进入此输入；本地测试请选择“本机麦克风”。</p> : null}
    {trackInfo ? <p aria-label="Qwen 实际麦克风">实际采集：{trackInfo}</p> : null}
    <p role="status">{status}</p>{error ? <p role="alert">{error}</p> : null}
    {source === 'microphone'
      ? <AnalyserMeter title="千问输入音量 · 本机麦克风" analyser={inputAnalyser} note="测量所选麦克风实际采样，不播放输入声音。"/>
      : <IncomingMeter enabled={busy} title="千问输入音量 · 企微接收音频" note="测量企微采集的 PCM 输入，连接千问后自动显示电平。"/>}
    <AnalyserMeter title="千问输出音量 · 虚拟话筒" analyser={outputAnalyser} note="测量千问回复在实际播放时的电平，输出到选定的 Node Audio Send / BlackHole。"/>
    <p role="status" aria-label="千问视频链路">{source === 'wecom'
      ? !busy ? '视频：未连接；连接后转发已采集的企微窗口。'
        : !diagnostics?.videoFrames ? '视频：等待采集画面发送；请确认左侧视频接收有画面。'
          : `视频：已向千问发送 ${diagnostics.videoFrames} 帧 · ${(diagnostics.videoBytes / 1024).toFixed(0)} KB · 每秒一帧`
      : '视频：本机麦克风模式不发送画面。'}</p>
    {busy && diagnostics?.phase === 'ready' && diagnostics.inputPackets > 0 && !diagnostics.speechStarted
      ? <p role="status">{diagnostics.inputRms > 0.001 ? '已有输入信号，等待千问检测到完整语句。' : '输入流已连接，当前没有明显声音。请检查所选输入来源并说一句完整的话。'}</p> : null}
    <details aria-label="Qwen 音频链路诊断"><summary>音频链路诊断</summary>
      <p>链路状态：{!busy ? (error ? '连接失败 / 已停止（见上方原因）' : '未连接；等待企微接通，也可手动连接') : !diagnostics ? '初始化 / 等待服务诊断' : diagnostics.phase === 'ready' ? '服务已确认配置；输入是否送达请看下方计数' : diagnostics.phase === 'connecting' ? '正在连接服务 / 确认配置' : '会话已停止'}</p>
      <p>输入已发送至服务：{diagnostics?.inputPackets ?? 0} 包 / {diagnostics?.inputBytes ?? 0} 字节；最近一秒信号 RMS：{(diagnostics?.inputRms ?? 0).toFixed(4)}（0 为静音或本秒无输入；有信号不等于已识别语义）</p>
      <p>服务检测说话：开始 {diagnostics?.speechStarted ?? 0} / 停止 {diagnostics?.speechStopped ?? 0} / 输入已提交 {diagnostics?.committed ?? 0}</p>
      <p>视频已发送：{diagnostics?.videoFrames ?? 0} 帧 / {diagnostics?.videoBytes ?? 0} 字节；跳过 {diagnostics?.videoSkipped ?? 0} 帧。</p>
      <p>回复：已请求 {diagnostics?.responseRequested ?? 0} / 服务已创建 {diagnostics?.responseCreated ?? 0} / 有效音频 {diagnostics?.audioBytes ?? 0} 字节 / 已结束 {diagnostics?.responseDone ?? 0}（含取消）</p>
      <p>客户端虚拟话筒已排程：{output.packets} 包 / {output.bytes} 字节；当前排队约 {output.queuedMs} 毫秒。排程不代表企微已接收或本机已听见。</p>
      <p>排查：输入为 0 → 检查是否连接、是否启动企微采集；有输入但无说话事件 → 检查信号和服务 VAD；已提交但无回复音频 → 检查请求 / 创建 / 结束计数；有音频但未排程 → 检查浏览器输出错误。</p>
      <small>计数为本次连接累计，约每秒刷新；断开保留最后读数，重连清零。诊断不保存原始音频、识别文本或服务凭据。</small>
    </details>
    <p><strong>回复输出到选定的虚拟话筒，不是本机扬声器；本机听不到不代表没有生成回复。</strong></p>
    <p>企微输入选择 Node Virtual Mic（或 BlackHole）；OBS 继续使用 /studio/output。戴耳机，勿将企微扬声器设为虚拟输入，避免回送。</p>
  </section>;
}
