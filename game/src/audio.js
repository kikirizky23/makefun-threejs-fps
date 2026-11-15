// audio.js — synthesized sound effects for EMBERWORKS. No audio files:
// every sound is built from oscillators + filtered noise buffers.
// The AudioContext is created lazily on the first user gesture (Play click),
// so browsers never block it as autoplay.
export function createAudio() {
  let ctx = null;
  let master = null;
  let noiseBuf = null;

  // Call from a user gesture (Play button). Safe to call twice.
  function ensure() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);
    // 1s of white noise, reused by every noise-based sound.
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return ctx;
  }

  function tone(freq, dur, type = 'sine', vol = 0.5, slideTo = null, delay = 0) {
    if (!ensure()) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function noise(dur, vol = 0.5, filterFreq = 1000, type = 'lowpass', delay = 0) {
    if (!ensure()) return;
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.value = filterFreq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(filt).connect(g).connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  return {
    unlock: ensure,
    get ready() { return !!ctx; },

    // kind: 'rifle' | 'pistol' | 'smg' | 'sniper' — pitch/length per weapon.
    // Noise burst = the crack, square tone sliding down = the body.
    shot(kind = 'rifle') {
      const cfg = {
        rifle: { f: 180, d: 0.12, v: 0.7 },
        pistol: { f: 220, d: 0.09, v: 0.55 },
        smg: { f: 240, d: 0.08, v: 0.5 },
        sniper: { f: 120, d: 0.28, v: 0.9 },
      }[kind] || { f: 180, d: 0.12, v: 0.7 };
      noise(cfg.d, cfg.v, 2500, 'lowpass');
      tone(cfg.f, cfg.d, 'square', cfg.v * 0.4, cfg.f * 0.4);
    },

    reload() {
      tone(500, 0.05, 'square', 0.25); // mag out
      tone(350, 0.05, 'square', 0.25, null, 0.18); // mag in
      tone(700, 0.06, 'square', 0.3, null, 0.38); // rack
    },

    hit() { tone(1200, 0.06, 'sine', 0.4); }, // hitmarker tick

    kill() {
      tone(880, 0.08, 'sine', 0.45);
      tone(1320, 0.12, 'sine', 0.45, null, 0.08);
    },

    plantBeep() { tone(1000, 0.08, 'square', 0.3); },

    explosion() {
      noise(1.2, 1.0, 400, 'lowpass');
      tone(60, 1.0, 'sine', 0.9, 30);
    },

    footstep() { noise(0.06, 0.12, 500, 'lowpass'); },

    roundStart() {
      tone(440, 0.12, 'sine', 0.4);
      tone(660, 0.2, 'sine', 0.4, null, 0.14);
    },

    buy() {
      tone(660, 0.07, 'sine', 0.35);
      tone(990, 0.1, 'sine', 0.35, null, 0.07);
    },

    // Short beep while the bomb fuse runs (called once per second).
    fuseTick() { tone(1400, 0.05, 'square', 0.2); },
  };
}
