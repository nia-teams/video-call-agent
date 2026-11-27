import type { measure } from "./audio-math.mjs";
type Level = ReturnType<typeof measure>;
export function Meter({title,level,active,note}:{title:string;level:Level;active:boolean;note:string}) {
  const format=(v:number)=>v<=-96?'−∞':v.toFixed(1);
  const percent=Math.max(0,Math.min(100,(level.rms+60)/60*100));
  return <div className="audio-meter"><div className="audio-meter-head"><strong>{title}</strong><span className={active&&level.signal?'meter-signal':''}>{!active?'无数据':level.clipped?'削波':level.signal?'有信号':'静音 / 低于 −60 dBFS'}</span></div><div role="meter" aria-label={title} aria-valuemin={-96} aria-valuemax={0} aria-valuenow={Math.min(0,level.rms)} className="audio-meter-track"><i style={{width:`${percent}%`,background:level.clipped?'#fc7969':undefined}}/></div><div className="audio-meter-values"><b>RMS {format(level.rms)} dBFS</b><span>峰值 {format(level.peak)} dBFS</span></div><small>{note}</small></div>;
}
