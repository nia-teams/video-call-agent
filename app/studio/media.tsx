'use client';
import dynamic from 'next/dynamic';
const LiveCanvasOutput = dynamic(() => import('../live-canvas/output'), { ssr: false });
import { useEffect, useRef, useState } from 'react';
export type Source = {kind:string; url:string; revision:number; playing:boolean; startedAt:number; loop:boolean};
export type AutoCall = { id:string;phase:'waiting'|'capturing'|'ready'|'ended'|'error';message:string;windowID:number|null };
export type CallRecording = {id:string;startedAt:number;duration:number;bytes:number;packets:number[];inputDevice:string;warning:string};
export type StudioState = {recordings?:{enabled:boolean;active:{id:string;startedAt:number;packets:number[];inputDevice:string}|null;error:string;items:CallRecording[]};source:Source; autoCall?:AutoCall|null; capture:{running:boolean; error:string; windowID:number|null}; frames:{incoming:number;outgoing:number}; audio:{incoming:number;outgoing:number}; lastVideo:number; lastAudio:number; nativeReady:boolean; blackHoleInstalled:boolean; autoAudio?:{active:boolean;message:string}|null};
let writeToken='';
export async function studioHeaders(contentType?:string, refresh = false):Promise<Record<string,string>> {
  if(refresh || !writeToken){const r=await fetch('/bridge/state',{cache:'no-store'});if(!r.ok)throw new Error('媒体服务未连接');writeToken=(await r.json()).csrfToken;}
  return {'X-Studio-Token':writeToken,...(contentType?{'Content-Type':contentType}:{})};
}
export async function command(path:string, payload:unknown = {}) {
  const response = await fetch(`/bridge/${path}`, {method:'POST',headers:await studioHeaders('application/json'),body:JSON.stringify(payload)});
  const result = await response.json(); if (!response.ok) {if(response.status===403)writeToken='';throw new Error(result.error || '操作失败');} return result;
}
export function useStudio(enabled = true) {
  const [state,setState] = useState<StudioState|null>(null), [error,setError] = useState('');
  useEffect(()=>{
    if(!enabled)return;
    const controller = new AbortController(); let timer:ReturnType<typeof setTimeout>;
    async function poll() {
      try { const r=await fetch('/bridge/state',{cache:'no-store',signal:controller.signal}); if(!r.ok) throw new Error(); const data=await r.json();writeToken=data.csrfToken;setState(data);setError(''); }
      catch { if(!controller.signal.aborted) setError('媒体服务未连接，请运行 npm start'); }
      if(!controller.signal.aborted) timer=setTimeout(()=>void poll(),1000);
    }
    void poll(); return ()=>{controller.abort();clearTimeout(timer);};
  },[enabled]); return {state,error};
}
export function OutputVideo({source}:{source:Source|null}) {
  const video = useRef<HTMLVideoElement>(null); const [failure,setFailure] = useState('');
  useEffect(()=>{ setFailure(''); },[source?.revision]);
  useEffect(()=>{
    const el=video.current; if(!el || !source || !source.url) return;
    const sync=()=>{
      if(Number.isFinite(el.duration) && el.duration>0) {
        const elapsed=(Date.now()-source.startedAt)/1000;
        const target=source.loop?elapsed%el.duration:Math.min(el.duration,elapsed);
        if(Math.abs(el.currentTime-target)>1.5) el.currentTime=target;
      }
      if(source.playing) void el.play().then(()=>setFailure('')).catch(error=>{if(error.name!=='AbortError')setFailure('视频无法自动播放，请检查格式或 OBS 浏览器源设置');}); else el.pause();
    };
    el.addEventListener('loadedmetadata',sync); sync(); const interval=setInterval(sync,3000);
    return ()=>{el.removeEventListener('loadedmetadata',sync);clearInterval(interval);};
  },[source?.revision,source?.url,source?.playing,source?.startedAt,source?.loop]);
  if(source?.kind==='live-canvas') return <LiveCanvasOutput/>;
  if(source?.kind==='live') return <img className="studio-picture" src="/bridge/video/outgoing" alt="网页实时输出"/>;
  if(source?.kind==='avatar') return <iframe title="内置数字人实时输出" src="/bridge/avatar/rig/index.html?embed=1&studio=1&v=6" style={{width:'100%',height:'100%',border:0,display:'block',background:'radial-gradient(ellipse at 50% 30%,#4a3a30,#211d1b)'}}/>;
  if(!source || !['file','url'].includes(source.kind)) return <div className="studio-placeholder">等待视频输入</div>;
  return <><video key={source.revision} ref={video} className="studio-picture" src={`${source.url}${source.kind==='file'?`?v=${source.revision}`:''}`} muted autoPlay playsInline loop={source.loop} onError={()=>setFailure('无法解码此视频，请使用 H.264 MP4 或浏览器支持的直链')}/>{failure?<p role="alert">{failure}</p>:null}</>;
}
type SinkContext = AudioContext & {setSinkId?:(id:string)=>Promise<void>};
export function PcmMonitor({channel,sink,onError,disabled=false}:{channel:'incoming'|'outgoing';sink?:string;onError:(error:string)=>void;disabled?:boolean}) {
  const current=useRef<{context:SinkContext; events:EventSource}|null>(null); const [playing,setPlaying]=useState(false);
  function stop(){current.current?.events.close();void current.current?.context.close();current.current=null;setPlaying(false);}
  useEffect(()=>()=>{current.current?.events.close();void current.current?.context.close();},[]);
  useEffect(()=>{stop();},[sink]);
  useEffect(()=>{if(disabled)stop();},[disabled]);
  async function start(){
    let context:SinkContext|undefined;
    try {
      if(channel==='outgoing'&&!sink) throw new Error('请先选择 Node Audio Send 或 BlackHole 输出设备');
      context=new AudioContext({sampleRate:48000});
      if(sink){if(!context.setSinkId)throw new Error('请使用支持音频输出选择的新版 Chrome');await context.setSinkId(sink);}
      await context.resume(); const ctx=context; let until=ctx.currentTime;
      const events=new EventSource(`/bridge/audio/${channel}`);
      events.onmessage=e=>{
        const {pcm}=JSON.parse(e.data) as {pcm:string}; const bytes=Uint8Array.from(atob(pcm),c=>c.charCodeAt(0));
        const floats=new Float32Array(bytes.buffer); const frames=floats.length/2;
        if(!Number.isInteger(frames)||frames===0)return;
        if(until>ctx.currentTime+0.35) return;
        const buffer=ctx.createBuffer(2,frames,48000);
        for(let ch=0;ch<2;ch++){const data=buffer.getChannelData(ch);for(let i=0;i<frames;i++)data[i]=Number.isFinite(floats[i*2+ch])?Math.max(-1,Math.min(1,floats[i*2+ch])):0;}
        const node=ctx.createBufferSource();node.buffer=buffer;node.connect(ctx.destination);
        until=Math.max(until,ctx.currentTime+0.04);node.start(until);until+=buffer.duration;node.onended=()=>node.disconnect();
      };
      events.onerror=()=>onError('音频流连接中断；请停止监听并检查服务');
      current.current={context:ctx,events};setPlaying(true);
    } catch(e){void context?.close();onError(e instanceof Error?e.message:'音频启动失败');}
  }
  return <button disabled={disabled} onClick={()=>playing?stop():void start()}>{playing?'停止':channel==='incoming'?'监听企微接收音频':'启用 API 音频 → 企微'}</button>;
}
