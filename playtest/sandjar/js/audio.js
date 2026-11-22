// 声音：全部现场合成，灰盒先有落沙声、消除声、连击升调、瓶子满了。
// iOS 用 ambient：跟随静音键、跟别的声音混着放、灵动岛不出现播放标记（环球躲烟踩过的坑）。
const Snd = (() => {
  let ctx = null, master = null, noiseBuf = null;
  let on = true;
  try { on = localStorage.getItem('sand1-snd') !== '0'; } catch (e) { /* 没有存储也能玩 */ }

  function unlock() {
    try { if (navigator.audioSession) navigator.audioSession.type = 'ambient'; } catch (e) { /* 老浏览器没有 */ }
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain(); master.gain.value = 0.5; master.connect(ctx.destination);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
  }

  function noise(dur, freq, q, vol, delay) {
    if (!on || !ctx) return;
    const t = ctx.currentTime + (delay || 0);
    const src = ctx.createBufferSource(); src.buffer = noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.05);
  }

  function tone(freq, delay, dur, vol, type) {
    if (!on || !ctx) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator(); o.type = type || 'triangle'; o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.008); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.05);
  }

  // 五声音阶，连击一级一级往上走
  const SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];
  const note = k => 523.25 * Math.pow(2, SCALE[Math.min(SCALE.length - 1, k)] / 12);

  return {
    unlock,
    get on() { return on; },
    toggle() {
      on = !on;
      try { localStorage.setItem('sand1-snd', on ? '1' : '0'); } catch (e) { /* 忽略 */ }
      return on;
    },
    pick() { tone(880, 0, 0.05, 0.08, 'sine'); },
    land(cells) { noise(0.18 + cells * 0.03, 2600, 0.9, 0.22); noise(0.35, 900, 0.7, 0.12, 0.03); },
    clear(combo) {
      const k = (combo - 1) * 2;
      tone(note(k), 0, 0.35, 0.16); tone(note(k + 2), 0.07, 0.35, 0.14); tone(note(k + 4), 0.14, 0.5, 0.13);
      noise(0.6, 1800, 0.5, 0.18);
    },
    over() { tone(392, 0, 0.3, 0.14); tone(330, 0.15, 0.3, 0.13); tone(262, 0.3, 0.6, 0.13); },
  };
})();
