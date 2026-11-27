/* Sandbox-only motion study: authored short gestures and held gaze targets.
 * Speech facial accents blend over the rig expression; the mouth stays audio-owned.
 */
(function(root){
'use strict';
const axes=['ax','ay','az','bx','by','bz'];
const zero=()=>Object.fromEntries(axes.map(k=>[k,0]));
const ease=t=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);};
class PresenceMotion {
  constructor(random=Math.random){this.random=random;this.rhythmic=true;this.pose=zero();this.velocity=zero();this.gaze={x:0,y:0};this.events=[];this.setState('idle',0);}
  between(a,b){return a+(b-a)*this.random();}
  record(name,now){this.events.push({name,time:now});if(this.events.length>30)this.events.shift();}
  setState(state,now,interrupted=false){
    if(!['idle','listening','thinking','speaking'].includes(state))throw new Error('Unknown presence state');
    this.voiceMean=0;this.voiceActive=false;this.quietSince=now;this.facePulse=null;this.nextAccent=now+.25;this.accentIndex=0;
    this.state=state;this.since=now;this.cue=null;this.nextCue=now+this.between(2.5,4.2);
    this.initialThinkingGlance=state==='thinking';
    this.nextGaze=now+(state==='thinking'?1.9:2.2);this.gazeTarget=state==='thinking'?{x:.32,y:.22}:{x:0,y:0};
    this.lastVoice=now;this.hadVoice=false;this.pauseHandled=false;this.cooldown=now+1.2;
    this.record(state,now);
    if(state==='listening'){this.startCue(interrupted&&this.rhythmic?'receive':'attend',now);if(interrupted&&this.rhythmic)this.facePulse={start:now,duration:1.15,kind:0};}
    if(state==='thinking')this.startCue('consider',now);
    if(state==='speaking')this.startCue('open',now);
  }
  startCue(name,now){
    const side=this.random()<.5?-1:1;
    const frames={
      receive:[[0,{}],[.24,{ay:-.055,by:.10,az:.025}],[.65,{ay:-.025,by:.075}],[1.45,{}]],
      attend:[[0,{}],[.35,{ay:.045,az:side*.07,by:.045}],[1.15,{ay:.045,az:side*.07,by:.045}],[1.9,{}]],
      nod:[[0,{}],[.22,{ay:.20,by:.055}],[.50,{ay:-.035,by:-.012}],[.82,{ay:.07}],[1.25,{}]],
      consider:[[0,{}],[.55,{ax:.09,ay:-.025,az:-.10,bx:.035}],[1.8,{ax:.09,ay:-.025,az:-.10,bx:.035}],[2.7,{}]],
      tilt:[[0,{}],[.55,{ax:side*.075,az:side*.13,bx:side*.055,bz:side*.07}],[1.35,{ax:side*.075,az:side*.13,bx:side*.055,bz:side*.07}],[2.2,{}]],
      open:[[0,{}],[.30,{ay:-.055,az:side*.06,by:-.025}],[.72,{ay:.025,az:side*.035}],[1.3,{}]],
      phrase:[[0,{}],[.25,{ay:.08,az:side*.085,bx:side*.045}],[.65,{ay:.025,az:side*.06,bx:side*.045}],[1.25,{}]],
      shift:[[0,{}],[.9,{bx:side*.13,bz:side*.12,az:-side*.08}],[2.1,{bx:side*.13,bz:side*.12,az:-side*.08}],[3.2,{}]],
    };
    this.cue={name,start:now,frames:frames[name]};this.record(name,now);
    this.nextCue=now+frames[name].at(-1)[0]+this.between(2.1,4.1);
  }
  step(now,dt,voice=0){
    dt=Math.max(0,Math.min(.05,dt));
    const wasActive=this.voiceActive;
    this.voiceActive=voice>.035;
    const resumed=this.voiceActive&&!wasActive&&now-this.quietSince>.20;
    if(!this.voiceActive&&wasActive)this.quietSince=now;
    this.voiceMean+=(voice-this.voiceMean)*(1-Math.exp(-dt*2));
    const emphasis=this.voiceActive&&voice>Math.max(.065,this.voiceMean*1.45);
    if(this.rhythmic&&this.state==='speaking'&&now>=this.nextAccent&&(resumed||emphasis)){
      this.facePulse={start:now,duration:resumed?1.15:.90,kind:this.accentIndex++%3};
      this.nextAccent=now+1.35;
      this.record(resumed?'voice-onset':'voice-emphasis',now);
      if(!this.cue)this.startCue('open',now);
    }
    if(voice>.035){this.lastVoice=now;this.hadVoice=true;this.pauseHandled=false;}
    if(this.state==='speaking'&&this.hadVoice&&!this.pauseHandled&&now-this.lastVoice>.24){
      this.pauseHandled=true;
      if(!this.cue&&now>this.cooldown){this.startCue('phrase',now);this.cooldown=now+2.8;}
    }
    if(!this.cue&&now>=this.nextCue&&this.state!=='speaking'){
      this.startCue(this.state==='listening'?(this.random()<.65?'nod':'tilt'):this.state==='thinking'?'tilt':'shift',now);
    }
    if(now>=this.nextGaze){
      // Most attention stays with the caller; occasional brief glances return explicitly.
      const away=!this.initialThinkingGlance&&this.state!=='speaking'&&this.random()<.3;
      this.initialThinkingGlance=false;
      this.gazeTarget=away?{x:this.between(-.22,.22),y:this.between(-.08,.12)}:{x:0,y:0};
      this.nextGaze=now+(away?this.between(.6,1.2):this.between(2.0,4.5));
    }
    // One short facial accent per phrase beat, not one twitch per audio frame.
    if(!this.rhythmic&&this.state==='speaking'&&voice>.05&&now>=this.nextAccent){
      this.facePulse={start:now,duration:this.between(.85,1.3),kind:this.accentIndex++%3};
      this.nextAccent=now+this.between(1.65,2.7);
    }
    let face={browL:0,browR:0,eyeL:1,eyeR:1,gx:0,gy:0};
    if(this.facePulse){
      const age=now-this.facePulse.start,duration=this.facePulse.duration;
      if(age>=duration)this.facePulse=null;
      else{
        const w=age<.22?ease(age/.22):1-ease((age-.22)/(duration-.22));
        const kind=this.facePulse.kind;
        face=kind===0?{browL:.64*w,browR:.55*w,eyeL:1+.13*w,eyeR:1+.11*w,gx:.07*w,gy:.035*w}:
          kind===1?{browL:.15*w,browR:.25*w,eyeL:1-.18*w,eyeR:1-.15*w,gx:-.10*w,gy:0}:
          {browL:.62*w,browR:.25*w,eyeL:1+.08*w,eyeR:1-.035*w,gx:.09*w,gy:.045*w};
      }
    }
    let target=zero();
    if(this.cue){
      const age=now-this.cue.start,frames=this.cue.frames;
      if(age>=frames.at(-1)[0])this.cue=null;
      else{
        let n=1;while(n<frames.length-1&&age>frames[n][0])n++;
        const [t0,a]=frames[n-1],[t1,b]=frames[n],w=ease((age-t0)/(t1-t0));
        for(const k of axes)target[k]=(a[k]||0)+((b[k]||0)-(a[k]||0))*w;
      }
    }
    // Critically damped head/body settling. Bounded substeps survive background-tab resumes.
    const steps=Math.max(1,Math.ceil(dt/(1/120))),h=dt/steps;
    for(let i=0;i<steps;i++)for(const k of axes){const omega=k[0]==='b'?7:12;this.velocity[k]+=(omega*omega*(target[k]-this.pose[k])-2*omega*this.velocity[k])*h;this.pose[k]+=this.velocity[k]*h;}
    const g=1-Math.exp(-dt*17);this.gaze.x+=(this.gazeTarget.x-this.gaze.x)*g;this.gaze.y+=(this.gazeTarget.y-this.gaze.y)*g;
    return {...this.pose,face,gx:this.gaze.x,gy:this.gaze.y,cue:this.cue?.name||'hold'};
  }
}
root.PresenceMotion=PresenceMotion;
if(typeof module!=='undefined')module.exports=PresenceMotion;
})(globalThis);
