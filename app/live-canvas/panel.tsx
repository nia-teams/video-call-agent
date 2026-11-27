'use client';

import { useEffect, useRef, useState } from 'react';
import { CanvasStage } from './components/CanvasStage';
import { truncateAppendContent, type CanvasFrame, type StreamEvent, type Transcript } from '../../lib/live-canvas/protocol';
import { readNdjson } from '../../lib/live-canvas/stream';
import { waitForIce } from '../../lib/live-canvas/webrtc';

import { useStudio } from '../studio/media';
import { isExplicitDevice, isVirtualOutput } from '../studio/audio-devices';
import { qwenOutput } from '../qwen/audio-devices';
import { acquireProviderSession } from '../../lib/studio/provider-session';
import { createWecomAudioOutput, type OutputLevel } from './wecom-output';
import { createWecomAudioInput } from './wecom-audio';
import { useLiveCanvasAutoCall } from './use-auto-call';
import { useCanvasPublisher } from './publisher';
import './live-canvas.css';

type Status = 'idle' | 'connecting' | 'live' | 'demo';
type Run = {
  kind: 'live' | 'demo'; source?: 'microphone' | 'wecom'; release?: () => void; input?: { close: () => void }; output?: Awaited<ReturnType<typeof createWecomAudioOutput>>; abort: AbortController; sessionId?: string; canvasToken?: string;
  peer?: RTCPeerConnection; mic?: MediaStream; channel?: RTCDataChannel; startTimer?: number; started?: boolean;
  queue: Promise<void>; pending: number; seq: number; transcripts: Transcript[]; seen: Set<string>;
};
type Work = { delegationId?: string | null; canvasTap?: string; revision?: number };
const headers = { 'Content-Type': 'application/json' };
const statusLabel: Record<Status, string> = { idle: '未通话', connecting: '正在连接 GPT-Live', live: 'GPT-Live · WebRTC', demo: '无 Key · 本地演示' };
const errText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。';

export default function LiveCanvas({ sourceRevision }: { sourceRevision: number }) {
  const active = useRef<Run | null>(null);
  const audio = useRef<HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }>(null);
  const { state: studio } = useStudio(sourceRevision > 0);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [sink, setSink] = useState('');
  const testAbort = useRef<AbortController | null>(null);
  const [testingOutput, setTestingOutput] = useState(false);
  const lastFrame = useRef<CanvasFrame | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [frame, setFrame] = useState<CanvasFrame | null>(null);
  const publishError = useCanvasPublisher(frame, sourceRevision);
  const [history, setHistory] = useState<{ revision: number; title?: string }[]>([]);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [muted, setMuted] = useState(false);
  const [speakDemo, setSpeakDemo] = useState(false);
  const speakDemoRef = useRef(false);
  const [captions, setCaptions] = useState({ user: '', assistant: '' });
  const [error, setError] = useState('');
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [outputLevel, setOutputLevel] = useState<OutputLevel>({ rms: -96, peak: -96, received: false });
  const outputs = devices.filter(device => device.kind === 'audiooutput' && isExplicitDevice(device) && isVirtualOutput(device.label));
  const outputReady = outputs.some(device => device.deviceId === sink);
  const wecomReady = studio?.autoCall?.phase === 'ready' && studio.capture.running && studio.capture.windowID === studio.autoCall.windowID;
  useEffect(() => {
    let disposed = false;
    const update = async () => {
      const next = await navigator.mediaDevices.enumerateDevices();
      if (!disposed) { setDevices(next); setSink(current => qwenOutput(next, current)); }
    };
    void update().catch(() => {});
    const changed = () => { void update().catch(() => {}); };
    navigator.mediaDevices?.addEventListener('devicechange', changed);
    return () => { disposed = true; navigator.mediaDevices?.removeEventListener('devicechange', changed); };
  }, []);
  useLiveCanvasAutoCall(studio, {
    sourceRevision, outputReady, busy: status !== 'idle', source: active.current?.source || active.current?.kind || '',
    start: () => { void startLive('wecom'); },
    stop: () => { if (active.current) close(active.current); }, onError: setError,
  });
  async function refreshDevices() {
    try {
      const permission = await navigator.mediaDevices.getUserMedia({ audio: true });
      permission.getTracks().forEach(track => track.stop());
      const next = await navigator.mediaDevices.enumerateDevices();
      setDevices(next); setSink(current => qwenOutput(next, current));
      if (!next.some(device => device.kind === 'audiooutput' && isExplicitDevice(device) && isVirtualOutput(device.label))) setError('未找到 Node Audio Send / BlackHole，请检查虚拟音频设备');
      else setError('');
    } catch { setError('无法读取音频设备，请检查浏览器权限'); }
  }

  function close(run: Run, reason = '') {
    if (active.current !== run) return;
    active.current = null;
    run.abort.abort();
    window.clearTimeout(run.startTimer);
    run.channel?.close();
    run.peer?.close();
    run.mic?.getTracks().forEach(track => track.stop());
    run.input?.close();
    run.output?.close();
    run.release?.();
    if (audio.current) audio.current.srcObject = null;
    if (run.kind === 'demo' && speakDemoRef.current) window.speechSynthesis?.cancel();
    if (run.canvasToken) void fetch('/api/live/session', {
      method: 'DELETE', headers, keepalive: true, body: JSON.stringify({ sessionId: run.sessionId, canvasToken: run.canvasToken }),
    }).catch(() => undefined);
    setOutputLevel({ rms: -96, peak: -96, received: false });
    setStatus('idle'); setBusy(false); setMuted(false); setAudioBlocked(false); setError(reason);
    setFrame(lastFrame.current);
  }
  useEffect(() => {
    const dispose = () => { testAbort.current?.abort(); if (active.current) close(active.current); };
    window.addEventListener('pagehide', dispose);
    return () => { window.removeEventListener('pagehide', dispose); dispose(); };
  }, []);

  function begin(kind: Run['kind']) {
    if (active.current) close(active.current);
    const run: Run = { kind, abort: new AbortController(), queue: Promise.resolve(), pending: 0, seq: 0, transcripts: [], seen: new Set() };
    active.current = run;
    lastFrame.current = null;
    setFrame(null); setHistory([]); setRevision(0); setError(''); setCaptions({ user: '', assistant: '' });
    setStatus(kind === 'live' ? 'connecting' : 'demo');
    return run;
  }
  function append(run: Run, kind: 'thinking' | 'commentary', delegationId: string | null, text: string) {
    if (active.current !== run || run.channel?.readyState !== 'open') return;
    run.channel.send(JSON.stringify({
      type: `session.${kind}.append`, event_id: crypto.randomUUID(), delegation_id: delegationId,
      content: truncateAppendContent(text).content,
    }));
  }
  function handleFrame(event: CanvasFrame) {
    setFrame(event);
    if (!event.done) return;
    lastFrame.current = event;
    const id = event.revision;
    if (!id) return;
    setRevision(id);
    setHistory(items => items.some(item => item.revision === id) ? items : [...items, { revision: id, title: event.title }].slice(-25));
  }
  function onStream(run: Run, work: Work, event: StreamEvent) {
    if (active.current !== run) return;
    if (event.type === 'demo_session') { run.sessionId = event.content; return; }
    if (event.type === 'canvas_stream') { handleFrame(event); return; }
    if (event.type !== 'commentary' && event.type !== 'thinking') return;
    if (run.kind === 'live') append(run, event.type, work.delegationId ?? null, event.content);
    else if (event.type === 'commentary') {
      setCaptions(previous => ({ ...previous, assistant: event.content }));
      if (speakDemoRef.current && window.speechSynthesis) {
        window.speechSynthesis.cancel();
        const speech = new SpeechSynthesisUtterance(event.content);
        speech.lang = 'zh-CN';
        window.speechSynthesis.speak(speech);
      }
    }
  }
  function enqueue(run: Run, work: Work) {
    if (active.current !== run || run.pending >= 16) return;
    run.pending++;
    setBusy(true);
    run.queue = run.queue.then(async () => {
      if (active.current !== run) return;
      setError('');
      const batch = work.revision ? [] : run.transcripts.slice();
      const response = await fetch(`/api/live/${run.kind === 'demo' ? 'demo' : 'delegate'}`, {
        method: 'POST', headers, signal: run.abort.signal,
        body: JSON.stringify({ sessionId: run.sessionId, canvasToken: run.canvasToken, ...work, transcripts: batch }),
      });
      if (response.ok && batch.length) run.transcripts = run.transcripts.filter(item => item.seq > batch.at(-1)!.seq);
      await readNdjson(response, event => onStream(run, work, event));
    }).catch(cause => {
      if (active.current === run) { setFrame(lastFrame.current); setError(errText(cause)); }
    }).finally(() => {
      run.pending--;
      if (active.current === run && run.pending === 0) setBusy(false);
    });
  }
  async function testOutput() {
    const controller = new AbortController(); testAbort.current?.abort(); testAbort.current = controller;
    setTestingOutput(true); setError('');
    let output: Awaited<ReturnType<typeof createWecomAudioOutput>> | undefined;
    try {
      output = await createWecomAudioOutput(sink, outputs.find(device => device.deviceId === sink)?.label || '', controller.signal, setOutputLevel);
      await output.testTone();
    } catch (cause) { if (!controller.signal.aborted) setError(errText(cause)); }
    finally { output?.close(); setTestingOutput(false); setOutputLevel({ rms: -96, peak: -96, received: false }); }
  }
  async function startLive(source: 'microphone' | 'wecom' = 'microphone') {
    testAbort.current?.abort();
    const run = begin('live');
    run.source = source;
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) throw new Error('语音需要支持 WebRTC 的浏览器，以及 HTTPS 或 localhost。');
      const release = await acquireProviderSession(run.abort.signal);
      if (active.current !== run) { release(); return; }
      run.release = release;
      const el = audio.current;
      if (!el) throw new Error('语音播放器尚未就绪');
      let mic: MediaStream;
      if (source === 'wecom') {
        if (!wecomReady) throw new Error('企微通话采集尚未就绪');
        if (!outputReady || !sink) throw new Error('请选择 Node Audio Send / BlackHole 虚拟输出设备');
        const output = await createWecomAudioOutput(sink, outputs.find(device => device.deviceId === sink)!.label, run.abort.signal,
          level => { if (active.current === run) setOutputLevel(level); });
        if (active.current !== run) { output.close(); return; }
        run.output = output;
        const input = await createWecomAudioInput(message => close(run, message), run.abort.signal);
        if (active.current !== run) { input.close(); return; }
        run.input = input; mic = input.stream;
      } else {
        if (el.setSinkId) await el.setSinkId('default');
        if (active.current !== run) return;
        mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      if (active.current !== run) { mic.getTracks().forEach(track => track.stop()); return; }
      run.mic = mic;
      const peer = run.peer = new RTCPeerConnection();
      for (const track of mic.getAudioTracks()) peer.addTrack(track, mic);
      peer.ontrack = event => {
        const el = audio.current;
        if (!el || active.current !== run) return;
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        // Chromium's remote WebRTC receiver must have a playing media sink
        // before its track can reliably feed a MediaStreamAudioSourceNode.
        // The element stays muted when Web Audio owns the audible output.
        el.srcObject = stream;
        el.muted = !!run.output;
        void el.play().catch(() => { if (active.current === run) setAudioBlocked(true); });
        if (run.output) {
          void run.output.attach(stream).catch(() => { if (active.current === run) setAudioBlocked(true); });
        }
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'failed' || peer.connectionState === 'closed') close(run, 'WebRTC 连接失败，可重新拨打。');
      };
      const channel = run.channel = peer.createDataChannel('oai-events');
      channel.onclose = () => close(run, 'GPT-Live 数据通道已关闭。');
      channel.onmessage = ({ data }) => {
        if (active.current !== run || typeof data !== 'string') return;
        let event;
        try { event = JSON.parse(data); } catch { return; }
        if (!event || typeof event !== 'object') return;
        switch (event.type) {
          case 'session.started':
            run.started = true; window.clearTimeout(run.startTimer); setStatus('live'); break;
          case 'session.closed': close(run); break;
          case 'error':
          case 'session.error': setError('GPT-Live 返回错误。请检查连接或重新拨打。'); break;
          case 'session.input_transcript.delta':
          case 'session.output_transcript.delta': {
            if (typeof event.delta !== 'string') break;
            const role = event.type === 'session.input_transcript.delta' ? 'user' : 'assistant';
            run.transcripts.push({ seq: ++run.seq, role, text: event.delta });
            run.transcripts = run.transcripts.slice(-300);
            setCaptions(previous => ({ ...previous, [role]: (previous[role] + event.delta).slice(-180) }));
            break;
          }
          case 'session.delegation.created': {
            const id = event.delegation?.id;
            if (!run.started || event.delegation?.target !== 'client' || typeof id !== 'string' || !id || run.seen.has(id)) break;
            if (run.pending >= 16) { setError('后台请求积压，请稍后重试。'); break; }
            run.seen.add(id);
            if (run.seen.size > 500) run.seen.delete(run.seen.values().next().value!);
            append(run, 'thinking', id, '');
            enqueue(run, { delegationId: id });
            break;
          }
        }
      };
      await peer.setLocalDescription(await peer.createOffer());
      await waitForIce(peer, run.abort.signal);
      const response = await fetch('/api/live/session', {
        method: 'POST', headers, signal: run.abort.signal,
        body: JSON.stringify({ sdp: peer.localDescription?.sdp, voice: 'marin' }),
      });
      const answer = await response.json();
      if (!response.ok) throw new Error(answer?.error || 'Live 会话无法建立。');
      if (active.current !== run) return;
      run.sessionId = answer.session.id;
      run.canvasToken = answer.canvasToken;
      run.startTimer = window.setTimeout(() => close(run, '未收到 session.started。请检查 GPT-Live 接入权限或网络。'), 20_000);
      await peer.setRemoteDescription({ type: 'answer', sdp: answer.transport.sdp });
      // HTTP /live/sessions has already started the session; do not send session.start.
    } catch (cause) { close(run, errText(cause)); }
  }
  function onTap(text: string) {
    const run = active.current;
    if (!run?.sessionId || !lastFrame.current?.revision || run.pending >= 16) return;
    if (run.kind === 'live') {
      if (!run.started) return;
      append(run, 'thinking', null, `用户刚点击了画板内容：${text}`);
    } else if (run.pending) return;
    enqueue(run, { delegationId: null, canvasTap: text });
  }
  function toggleMute() {
    const tracks = active.current?.mic?.getAudioTracks();
    if (!tracks?.length) return;
    for (const track of tracks) track.enabled = muted;
    setMuted(!muted);
  }

  return <main className="phone live-canvas-app">
    <header className="top">
      <div className="brand">AI <span>LIVE CANVAS</span></div>
      <div className="badges">
        <span role="status" className={`pill ${status}`}><i />{statusLabel[status]}</span>
        <select aria-label="画板版本" value={revision} disabled={!active.current || busy || !history.length} onChange={event => {
          if (active.current) enqueue(active.current, { revision: Number(event.target.value) });
        }}>
          {!history.length && <option value={0}>暂无版本</option>}
          {history.map(item => <option key={item.revision} value={item.revision}>v{item.revision} · {item.title}</option>)}
        </select>
      </div>
    </header>
    <section className="stage" aria-label="实时画板">
      {!frame?.html && <div className="placeholder"><div className="orbit" /><p>声音与图解，同步展开</p><small>{busy ? '正在准备画面…' : '开始语音通话，或直接体验本地演示。'}</small></div>}
      <CanvasStage frame={frame} onInteract={onTap} />
      {frame && busy && <div className="working" role="status">绘制中…</div>}
    </section>
    <section className="captions" aria-label="实时字幕" aria-live="polite">
      {captions.user && <p><b>你</b>{captions.user.slice(-95)}</p>}
      <p><b>AI</b>{captions.assistant.slice(-120) || (status === 'live' ? '正在听你说…' : '语音字幕将在这里显示。')}</p>
    </section>
    <footer className="controls">
      {sourceRevision > 0 && <div className="wecom-auto-controls">
        <p role="status">企微自动通话：{studio?.autoCall?.message || '等待企微接通'}{!outputReady ? ' · 请先选择虚拟输出设备' : ''}</p>
        <select aria-label="Live Canvas 企微音频输出" value={sink} disabled={status !== 'idle'} onChange={event => setSink(event.target.value)}>
          <option value="">选择虚拟音频输出</option>
          {outputs.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
        </select>
        <button disabled={status !== 'idle'} onClick={() => void refreshDevices()}>授权并刷新音频设备</button>
        <button disabled={status !== 'idle' || testingOutput || !outputReady} onClick={() => void testOutput()}>{testingOutput ? '正在发送测试音…' : '测试企微发送声音'}</button>
        <p role="status">模型音频：{outputLevel.received ? `已接收 · 发送电平 ${outputLevel.rms.toFixed(1)} dBFS · 峰值 ${outputLevel.peak.toFixed(1)} dBFS` : '等待音轨'}</p>
        <meter aria-label="GPT-Live 企微发送电平" min={-96} max={0} value={outputLevel.rms}/>
        <small>企微麦克风需选择 {/BlackHole/i.test(outputs.find(device => device.deviceId === sink)?.label || '') ? 'BlackHole 2ch' : 'Node Virtual Mic'}。</small>
      </div>}
      {(error || publishError) && <p className="error" role="alert">{error || publishError}</p>}
      <audio ref={audio} autoPlay />
      {audioBlocked && <button onClick={() => void Promise.all([audio.current?.play(), active.current?.output?.resume()]).then(() => setAudioBlocked(false)).catch(() => undefined)}>启用企微声音</button>}
      <div className="callbar">
        <button className="primary" onClick={() => void startLive(wecomReady ? 'wecom' : 'microphone')} disabled={status === 'connecting' || status === 'live'}>开始语音通话</button>
        <button onClick={toggleMute} disabled={status !== 'live'} aria-pressed={muted}>{muted ? '取消静音' : '静音'}</button>
        <button className="hangup" disabled={status === 'idle'} onClick={() => { if (active.current) close(active.current); }}>{status === 'demo' ? '结束' : '挂断'}</button>
      </div>
      <button className="demo" disabled={status === 'demo' && busy} onClick={() => enqueue(begin('demo'), {})}>无 Key 演示边画边讲</button>
      <label className="demo-audio"><input type="checkbox" checked={speakDemo} onChange={event => {
        speakDemoRef.current = event.target.checked;
        setSpeakDemo(event.target.checked);
        if (!event.target.checked) window.speechSynthesis?.cancel();
      }} /> 演示语音朗读（可选）</label>
    </footer>
  </main>;
}
