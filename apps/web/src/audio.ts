// Every sound is synthesised in WebAudio: no audio files.

let ctx: AudioContext | null = null;
let muted = (() => { try { return localStorage.getItem('inside-job:muted') === '1'; } catch { return false; } })();
let hum: { stop: () => void } | null = null;
const ac = (): AudioContext | null => {
  if (muted) return null;
  try { ctx ??= new AudioContext(); if (ctx.state === 'suspended') void ctx.resume(); return ctx; } catch { return null; }
};
export const isMuted = (): boolean => muted;
export function setMuted(m: boolean): void {
  muted = m;
  try { localStorage.setItem('inside-job:muted', m ? '1' : '0'); } catch { /* fine */ }
  if (m) { hum?.stop(); hum = null; }
}

function tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.12, slide = 0, delay = 0): void {
  const a = ac(); if (!a) return;
  const t = a.currentTime + delay;
  const o = a.createOscillator(); const g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
}
function noise(dur: number, vol = 0.1, hp = 1200, delay = 0): void {
  const a = ac(); if (!a) return;
  const buf = a.createBuffer(1, Math.floor(a.sampleRate * dur), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const s = a.createBufferSource(); s.buffer = buf;
  const f = a.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp;
  const g = a.createGain(); g.gain.value = vol;
  s.connect(f).connect(g).connect(a.destination); s.start(a.currentTime + delay);
}

/** The building at night: a low air-conditioning hum and a slow detuned pad. */
export function startHum(): void {
  const a = ac();
  if (!a || hum) return;
  const g = a.createGain(); g.gain.value = 0.025;
  const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 380;
  const oscs = [55, 55.4, 82.5].map((f, i) => { const o = a.createOscillator(); o.type = i === 2 ? 'triangle' : 'sawtooth'; o.frequency.value = f; o.connect(lp); o.start(); return o; });
  lp.connect(g).connect(a.destination);
  hum = { stop: () => { for (const o of oscs) o.stop(); g.disconnect(); } };
}

export const sfx = {
  click: (): void => tone(880, 0.05, 'triangle', 0.06),
  step: (): void => noise(0.03, 0.02, 3000),
  duty: (): void => { tone(660, 0.1, 'sine', 0.12); tone(990, 0.18, 'sine', 0.12, 0, 0.09); },
  filed: (): void => { tone(1318, 0.08, 'square', 0.05); tone(1760, 0.12, 'square', 0.05, 0, 0.07); noise(0.05, 0.05, 4000, 0.02); },
  approve: (): void => { tone(1046, 0.08, 'triangle', 0.1); tone(1568, 0.16, 'triangle', 0.1, 0, 0.06); },
  reject: (): void => tone(180, 0.22, 'square', 0.07, -60),
  drain: (): void => { tone(400, 0.5, 'sawtooth', 0.08, -320); noise(0.4, 0.04, 600); },
  freeze: (): void => { noise(0.35, 0.14, 5000); tone(1800, 0.5, 'sine', 0.08, -1500); },
  meeting: (): void => { for (let k = 0; k < 3; k++) { tone(740, 0.16, 'square', 0.07, 0, k * 0.34); tone(554, 0.16, 'square', 0.07, 0, k * 0.34 + 0.17); } },
  vote: (): void => tone(523, 0.1, 'triangle', 0.09),
  reveal: (): void => { noise(0.12, 0.12, 200); tone(110, 0.4, 'sine', 0.15, -40); },
  lightsOut: (): void => { tone(300, 0.7, 'sawtooth', 0.08, -260); noise(0.2, 0.05, 800); },
  lightsOn: (): void => tone(220, 0.4, 'sawtooth', 0.06, 400),
  win: (): void => [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.3, 'triangle', 0.12, 0, i * 0.12)),
  lose: (): void => [392, 330, 262, 196].forEach((f, i) => tone(f, 0.35, 'triangle', 0.1, 0, i * 0.15)),
  error: (): void => tone(140, 0.2, 'square', 0.06),
};
