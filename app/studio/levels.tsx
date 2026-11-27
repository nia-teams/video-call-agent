'use client';
import { RefObject, useEffect, useRef, useState } from 'react';
import { measure } from './audio-math.mjs';
import { Meter } from './audio-meter';
import { isVirtualInput, virtualInput } from './audio-devices';
const silence=measure(new Float32Array(1));
export function AnalyserMeter({title,analyser,note}:{title:string;analyser:RefObject<AnalyserNode|null>;note:string}){
  const [level,setLevel]=useState(silence),[active,setActive]=useState(false);
  useEffect(()=>{const samples=new Float32Array(2048);const timer=setInterval(()=>{const node=analyser.current;const on=!!node&&node.context.state==='running';setActive(on);if(on){node.getFloatTimeDomainData(samples);setLevel(measure(samples));}else setLevel(silence);},100);return()=>clearInterval(timer);},[analyser]);
  return <Meter title={title} level={level} active={active} note={note}/>;
}
export function IncomingMeter({enabled,title="企微 → Node 接收音频",note="直接测量 Node 收到的 PCM；不播放声音、不触发额外采集。"}:{enabled:boolean;title?:string;note?:string}){
  const [level,setLevel]=useState(silence),[active,setActive]=useState(false);
  useEffect(()=>{
    if(!enabled){setLevel(silence);setActive(false);return;}
    const events=new EventSource('/bridge/audio/incoming');let last=0;
    let latest=silence;
    events.onmessage=e=>{try{const {pcm}=JSON.parse(e.data);const bytes=Uint8Array.from(atob(pcm),c=>c.charCodeAt(0));latest=measure(new Float32Array(bytes.buffer));last=Date.now();}catch{}};
    const timer=setInterval(()=>{const fresh=Date.now()-last<800;setActive(fresh);setLevel(fresh?latest:silence);},100);
    return()=>{events.close();clearInterval(timer);};
  },[enabled]);
  return <Meter title={title} level={level} active={active} note={note}/>;
}
export function BlackHoleMeter({onError}:{onError:(message:string)=>void}){
  const analyser=useRef<AnalyserNode|null>(null),monitorAnalyser=useRef<AnalyserNode|null>(null),resource=useRef<{context:AudioContext & {setSinkId?:(deviceId:string)=>Promise<void>};stream:MediaStream;source:MediaStreamAudioSourceNode;gain:GainNode;monitorAnalyser:AnalyserNode}|null>(null);
  const [active,setActive]=useState(false),[busy,setBusy]=useState(false);
  const [monitoring,setMonitoring]=useState(false),[monitorBusy,setMonitorBusy]=useState(false),[speakerName,setSpeakerName]=useState('');
  const [gainDb,setGainDb]=useState(6);
  const [inputName,setInputName]=useState('虚拟话筒');
  function stop(){resource.current?.stream.getTracks().forEach(t=>t.stop());void resource.current?.context.close();resource.current=null;analyser.current=null;monitorAnalyser.current=null;setActive(false);setMonitoring(false);}
  useEffect(()=>{
    if(resource.current?.context.state==='closed')resource.current=null;
    if(!resource.current){setActive(false);setMonitoring(false);analyser.current=null;monitorAnalyser.current=null;}
    return()=>{resource.current?.stream.getTracks().forEach(t=>t.stop());void resource.current?.context.close();resource.current=null;analyser.current=null;monitorAnalyser.current=null;};
  },[]);
  async function start(){
    setBusy(true);let stream:MediaStream|null=null,context:AudioContext|null=null;
    try {
      const list=await navigator.mediaDevices.enumerateDevices();
      const device=virtualInput(list);
      if(!device)throw new Error('请先点“授权并刷新音频设备”，再检测虚拟话筒。不会改用电脑麦克风。');
      stream=await navigator.mediaDevices.getUserMedia({audio:{deviceId:{exact:device.deviceId},echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false});
      if(!isVirtualInput(stream.getAudioTracks()[0]?.label||''))throw new Error('返回的输入不是虚拟话筒，已停止检测');
      setInputName(device.label);
      context=new AudioContext();await context.resume();const node=context.createAnalyser();node.fftSize=2048;
      const source=context.createMediaStreamSource(stream);source.connect(node);
      const gain=context.createGain();gain.gain.value=Math.pow(10,gainDb/20);
      const compressor=context.createDynamicsCompressor();compressor.threshold.value=-3;compressor.knee.value=0;compressor.ratio.value=20;compressor.attack.value=0.003;compressor.release.value=0.15;
      const output=context.createAnalyser();output.fftSize=2048;
      source.connect(gain);gain.connect(compressor);compressor.connect(output);
      analyser.current=node;monitorAnalyser.current=output;resource.current={context,stream,source,gain,monitorAnalyser:output};setActive(true);
    }catch(e){stream?.getTracks().forEach(t=>t.stop());void context?.close();onError(e instanceof Error?e.message:'电平检测失败');}
    finally{setBusy(false);}
  }
  async function toggleMonitor(){
    if(monitorBusy)return;
    const current=resource.current;
    if(monitoring&&current){current.monitorAnalyser.disconnect(current.context.destination);setMonitoring(false);return;}
    setMonitorBusy(true);
    try{
      if(resource.current?.context.state==='closed')resource.current=null;
      if(!resource.current)await start();
      const capture=resource.current;
      if(!capture)throw new Error('请先授权并启动虚拟话筒输入检测');
      const list=await navigator.mediaDevices.enumerateDevices();
      const speaker=list.find(d=>d.kind==='audiooutput'&&!['default','communications'].includes(d.deviceId)&&!d.label.toLowerCase().includes('blackhole')&&(/MacBook.*(扬声器|speakers)/i.test(d.label)||/内建.*扬声器|built-in.*speaker|speaker.*built-in/i.test(d.label)));
      if(!speaker)throw new Error('未找到电脑内建扬声器，请先“授权并刷新音频设备”。不会把声音回送到 BlackHole。');
      if(!capture.context.setSinkId)throw new Error('当前浏览器不支持选择播放设备，请使用新版 Chrome');
      await capture.context.setSinkId(speaker.deviceId);await capture.context.resume();
      if(resource.current!==capture)return;
      capture.monitorAnalyser.connect(capture.context.destination);
      setSpeakerName(speaker.label);setMonitoring(true);
    }catch(e){setMonitoring(false);onError(e instanceof Error?e.message:'虚拟话筒播放失败');}
    finally{setMonitorBusy(false);}
  }
  function changeGain(value:number){
    const next=Math.max(0,Math.min(24,value));setGainDb(next);
    const current=resource.current;if(current)current.gain.gain.setTargetAtTime(Math.pow(10,next/20),current.context.currentTime,0.02);
  }
  return <><div className="audio-monitor-controls"><button disabled={busy||monitorBusy} onClick={()=>active?stop():void start()}>{active?'停止虚拟话筒电平检测':'检测虚拟话筒实际输入电平'}</button><button disabled={busy||monitorBusy} aria-pressed={monitoring} onClick={()=>void toggleMonitor()}>{monitorBusy?'正在连接扬声器…':monitoring?'停止播放虚拟话筒':'播放虚拟话筒到电脑扬声器'}</button></div><div className="monitor-gain"><label htmlFor="virtual-mic-gain">扬声器监听增益 <strong>+{gainDb} dB · {Math.pow(10,gainDb/20).toFixed(1)} 倍</strong></label><input id="virtual-mic-gain" aria-label="扬声器监听增益" type="range" min="0" max="24" step="1" value={gainDb} onChange={e=>changeGain(Number(e.target.value))}/><div className="audio-monitor-controls"><button onClick={()=>changeGain(0)}>原音量</button><button onClick={()=>changeGain(6)}>+6 dB</button><button onClick={()=>changeGain(12)}>+12 dB</button><button onClick={()=>changeGain(18)}>+18 dB</button></div><small>仅放大本机监听，含动态压缩；不改变发送给企微的音频电平。</small></div>{monitoring?<><p role="status">正在播放到：{speakerName}。再次点击停止播放，电平检测继续。</p><AnalyserMeter title="电脑扬声器监听输出（放大后）" analyser={monitorAnalyser} note="增益和动态压缩之后的实际电平，可与下方原始虚拟输入比较。"/></>:null}<AnalyserMeter title={`${inputName} 实际输入`} analyser={analyser} note="读取虚拟话筒真实采样；播放按钮只连接电脑内建扬声器。停止播放不影响电平检测，不上传或保存采样。"/></>;
}
