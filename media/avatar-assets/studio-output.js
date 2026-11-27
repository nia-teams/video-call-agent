// Analysis only: audio playback belongs to the selected voice provider.
(() => {
  if (new URLSearchParams(location.search).get('studio') !== '1') return;
  let events, timer, waiting, lastSound = 0, connected = false, received = 0, forwarded = 0, lastError = "", peakMouth = 0, speakingTicks = 0;
  function reset(active = connected) {
    connected = active; lastSound = 0;
    window.Avatar?.resetAudio();
    window.Avatar?.setPresenceState(active ? 'listening' : 'idle');
  }
  function start() {
    if (!window.Avatar) { waiting = setTimeout(start, 100); return; }
    const avatar = window.Avatar;
    avatar.setMotionStyle('rhythmic'); reset(false);
    events = new EventSource('/bridge/avatar/events');
    events.onmessage = e => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "pcm") received++;
        if (data.type === 'reset') { reset(data.active); return; }
        if (data.type !== 'pcm') return;
        // PCM is emitted only for an active publisher. OBS can mark a live
        // source hidden while its window is backgrounded: keep analysing it.
        if (!connected) reset(true);
        const bytes = Uint8Array.from(atob(data.pcm), c => c.charCodeAt(0));
        const samples = new Float32Array(bytes.buffer);
        let energy = 0;
        for (let i = 0; i < samples.length; i++) {
          samples[i] = Number.isFinite(samples[i]) ? Math.max(-1, Math.min(1, samples[i])) : 0;
          energy += samples[i] * samples[i];
        }
        if (Math.sqrt(energy / samples.length) > 0.004) {
          lastSound = performance.now();
          if (avatar.presenceState !== 'speaking') avatar.setPresenceState('speaking');
        }
        avatar.pushAudioSamples(samples, data.sampleRate); forwarded++;
      } catch (error) { lastError = String(error.message || error); reset(); }
    };
    events.onerror = () => reset(false);
    timer = setInterval(() => {
      if (lastSound && performance.now() - lastSound > 250) reset();
      peakMouth = Math.max(peakMouth, avatar.params.O);
      if (avatar.presenceState === "speaking") speakingTicks++;
      const stage = document.getElementById("stage");
      if (stage) stage.dataset.lipState = JSON.stringify({connected,received,forwarded,hidden:document.hidden,mouth:avatar.params.O,rate:avatar.lipSyncSampleRate,presence:avatar.presenceState,peakMouth,speakingTicks,error:lastError});
    }, 80);
    // Window visibility does not change the lifetime of a live OBS source.
  }
  window.addEventListener('pagehide', () => { clearTimeout(waiting); clearInterval(timer); events?.close(); reset(false); });
  start();
})();
