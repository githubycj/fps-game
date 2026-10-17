// ===== 程序化音效（WebAudio，无需音频资源）=====
let ctx = null;

export function initAudio() {
  if (!ctx) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) ctx = new AC();
    } catch { /* 忽略 */ }
  }
  if (ctx && ctx.state === 'suspended') ctx.resume();
  return !!ctx;
}

function blip(type, f0, f1, dur, vol, filterFreq = 4000) {
  if (!ctx) return;
  try {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterFreq;
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  } catch { /* 忽略 */ }
}

export const sfx = {
  shoot()   { blip('square', 880, 180, 0.09, 0.10, 2600); },
  hit()     { blip('triangle', 1500, 800, 0.07, 0.16, 5000); },
  headshot(){ blip('square', 1900, 900, 0.12, 0.20, 6000); },
  kill()    { blip('sawtooth', 700, 90, 0.3, 0.20, 2000); blip('square', 1200, 300, 0.12, 0.14, 4000); },
  hurt()    { blip('sawtooth', 170, 80, 0.18, 0.22, 650); },
  headHurt(){ blip('sawtooth', 260, 60, 0.28, 0.28, 900); },
  death()   { blip('sawtooth', 320, 55, 0.55, 0.22, 1000); },
  jump()    { blip('sine', 480, 820, 0.08, 0.07, 2200); },
  join()    { blip('sine', 500, 900, 0.14, 0.08, 3000); },
  leave()   { blip('sine', 700, 420, 0.14, 0.07, 2600); },
  respawn() { blip('sine', 400, 950, 0.28, 0.09, 3200); },
  pickup()  { blip('square', 900, 1400, 0.12, 0.14, 4000); blip('sine', 1200, 1800, 0.1, 0.1, 5000); },
  heal()    { blip('sine', 500, 1200, 0.3, 0.12, 3500); },
  // 换弹：两声机械音（卸弹匣 + 上膛）
  reload()  { blip('square', 320, 210, 0.06, 0.08, 1500); setTimeout(() => blip('square', 230, 360, 0.08, 0.07, 1400), 90); },
  switchWeapon() { blip('sine', 760, 520, 0.07, 0.06, 2400); },
  dryFire() { blip('square', 170, 90, 0.05, 0.09, 900); },
};
