/* Синтезированные звуки бачата-метронома. Каждая функция ставит звук
 * на точное время t по часам AudioContext — поэтому темп не плавает.
 */

const noiseCache = new WeakMap();
function noise(ctx) {
  let buf = noiseCache.get(ctx);
  if (!buf) {
    buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.2), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, buf);
  }
  return buf;
}

function envelope(ctx, t, peak, decay, attack = 0.002) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  return g;
}

// Гуира — короткий шумовой щелчок, на каждый удар.
export function guira(ctx, out, t, peak = 0.35) {
  const src = ctx.createBufferSource(); src.buffer = noise(ctx);
  const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 6000;
  const g = envelope(ctx, t, peak, 0.045);
  src.connect(hp); hp.connect(g); g.connect(out);
  src.start(t); src.stop(t + 0.06);
}

// Бас — на 1 и 5.
export function bass(ctx, out, t) {
  const o = ctx.createOscillator(); o.type = "sine";
  o.frequency.setValueAtTime(110, t);
  o.frequency.exponentialRampToValueAtTime(55, t + 0.15);
  const g = envelope(ctx, t, 0.9, 0.35, 0.005);
  o.connect(g); g.connect(out);
  o.start(t); o.stop(t + 0.4);
}

// Бонго — акцент на 4 и 8.
export function bongo(ctx, out, t) {
  const o = ctx.createOscillator(); o.type = "sine";
  o.frequency.setValueAtTime(440, t);
  o.frequency.exponentialRampToValueAtTime(320, t + 0.08);
  const g = envelope(ctx, t, 0.55, 0.14);
  o.connect(g); g.connect(out);
  o.start(t); o.stop(t + 0.17);
  // шлепок ладони по мембране
  const src = ctx.createBufferSource(); src.buffer = noise(ctx);
  const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 2200; bp.Q.value = 1.2;
  const gn = envelope(ctx, t, 0.25, 0.02);
  src.connect(bp); bp.connect(gn); gn.connect(out);
  src.start(t); src.stop(t + 0.03);
}

// Клавес — звук отсчёта «5-6-7-8», чтобы его нельзя было спутать с музыкой.
export function clave(ctx, out, t, loud = false) {
  const o = ctx.createOscillator(); o.type = "triangle";
  o.frequency.value = loud ? 2500 : 2000;
  const g = envelope(ctx, t, loud ? 0.5 : 0.35, 0.05, 0.001);
  o.connect(g); g.connect(out);
  o.start(t); o.stop(t + 0.07);
}

// Всё, что звучит на одном ударе. count — счёт 1–8, countIn — это удар отсчёта.
export function playBeat(ctx, out, t, count, countIn) {
  if (countIn) { clave(ctx, out, t, count === 8); return; }
  guira(ctx, out, t);
  if (count === 1 || count === 5) bass(ctx, out, t);
  if (count === 4 || count === 8) bongo(ctx, out, t);
}
