/* Автоматическая первичная разметка: удары и догадка о «раз».
 * Чистый JS, без библиотек: сила атак → темп по автокорреляции → удары динамическим
 * программированием (Ellis, 2007). Темп ищется только в диапазоне бачаты — это сильно
 * помогает против ошибки «в 2 раза быстрее/медленнее».
 *
 * Почему не Essentia.js: она под AGPL-3.0 (для публичного сайта это обязывает открыть
 * весь код на тех же условиях) и весит несколько мегабайт, а здесь известен жанр.
 */

const SR = 11025;   // анализируем пониженную частоту — атаки ударных видны и так
const HOP = 128;    // шаг окна: ~11,6 мс
const N = 512;      // окно FFT

// Понижение частоты: усреднение по блоку (грубый фильтр) + выборка.
function downsample(x, sr) {
  const k = sr / SR, out = new Float32Array(Math.floor(x.length / k));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * k), b = Math.min(x.length, Math.floor((i + 1) * k));
    let s = 0; for (let j = a; j < b; j++) s += x[j];
    out[i] = s / Math.max(1, b - a);
  }
  return out;
}

// БПФ на месте (radix-2), re/im — Float64Array длины N.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const ai = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j + len / 2] = re[i + j] - ar; im[i + j + len / 2] = im[i + j] - ai;
        re[i + j] += ar; im[i + j] += ai;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

/* Сила атак: насколько выросла громкость по частотам (spectral flux) в каждом окне.
 * Отдельно — только низы (бас на 1 и 5): по ним угадываем «раз».
 */
function onsetEnvelope(x) {
  const frames = Math.floor((x.length - N) / HOP);
  const env = new Float32Array(frames), low = new Float32Array(frames);
  const win = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  let prev = new Float64Array(N / 2);
  const re = new Float64Array(N), im = new Float64Array(N);
  const lowBin = Math.round((150 / SR) * N);   // до 150 Гц
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N; i++) { re[i] = x[f * HOP + i] * win[i]; im[i] = 0; }
    fft(re, im);
    let s = 0, sl = 0;
    const mag = new Float64Array(N / 2);
    for (let b = 1; b < N / 2; b++) {
      mag[b] = Math.log1p(100 * Math.hypot(re[b], im[b]));
      const d = mag[b] - prev[b];
      if (d > 0) { s += d; if (b <= lowBin) sl += d; }
    }
    env[f] = s; low[f] = sl; prev = mag;
  }
  // убираем медленный фон (скользящее среднее ~0,5 с) и нормируем
  const w = Math.round(0.5 / (HOP / SR));
  const out = new Float32Array(frames);
  let acc = 0;
  for (let f = 0; f < frames; f++) {
    acc += env[f]; if (f >= w) acc -= env[f - w];
    out[f] = Math.max(0, env[f] - acc / Math.min(f + 1, w));
  }
  const sd = Math.sqrt(out.reduce((s, v) => s + v * v, 0) / frames) || 1;
  for (let f = 0; f < frames; f++) out[f] /= sd;
  return { env: out, low };
}

// Темп: пик автокорреляции силы атак в диапазоне bpmMin…bpmMax (с весом к ~125 BPM).
function estimatePeriod(env, bpmMin, bpmMax) {
  const fps = SR / HOP;
  const lagMin = Math.floor((60 / bpmMax) * fps), lagMax = Math.ceil((60 / bpmMin) * fps);
  let best = lagMin, bestV = -Infinity;
  const ac = [];
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let s = 0;
    for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag];
    // двойной и половинный период тоже подтверждают этот
    let s2 = 0;
    for (let i = 2 * lag; i < env.length; i++) s2 += env[i] * env[i - 2 * lag];
    const bpm = (60 * fps) / lag;
    const v = (s + 0.5 * s2) * Math.exp(-0.5 * (Math.log2(bpm / 125) / 0.5) ** 2);
    ac[lag] = v;
    if (v > bestV) { bestV = v; best = lag; }
  }
  // уточняем пик параболой
  const a = ac[best - 1] ?? bestV, c = ac[best + 1] ?? bestV;
  const shift = a - 2 * bestV + c ? (0.5 * (a - c)) / (a - 2 * bestV + c) : 0;
  return best + Math.max(-0.5, Math.min(0.5, shift));
}

/* Удары динамическим программированием: каждый удар стоит на сильной атаке, а интервал
 * между соседними близок к найденному периоду. tightness — насколько строго держать темп.
 */
function trackBeats(env, period, tightness = 80) {
  const n = env.length, score = new Float64Array(n), back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2), hi = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let best = 0, arg = -1;
    for (let p = t - hi; p <= t - lo; p++) {
      if (p < 0) continue;
      const v = score[p] - tightness * Math.log((t - p) / period) ** 2;
      if (v > best || arg < 0) { best = v; arg = p; }
    }
    score[t] = env[t] + (arg >= 0 ? best : 0);
    back[t] = arg;
  }
  // конец — лучший счёт в последнем периоде
  let t = n - 1, bestEnd = -Infinity;
  for (let k = Math.max(0, n - Math.round(period)); k < n; k++) if (score[k] > bestEnd) { bestEnd = score[k]; t = k; }
  const beats = [];
  while (t >= 0) { beats.push(t); t = back[t]; }
  return beats.reverse();
}

/* x — моно-сигнал, sr — его частота. Возвращает { beats (с), bpm, onePhase, confidence }.
 * onePhase — какой из ударов по счёту (0…3) похож на «раз»: там бас. Бас звучит и на 1,
 * и на 5, поэтому «раз» или «пять» — решает человек кнопкой «Здесь раз».
 */
export function detectBeats(x, sr, { bpmMin = 100, bpmMax = 160 } = {}) {
  const y = downsample(x, sr);
  const { env, low } = onsetEnvelope(y);
  const period = estimatePeriod(env, bpmMin, bpmMax);
  const frames = trackBeats(env, period);
  // Атака попадает в разницу спектров, когда уже вошла в окно, — поэтому к номеру окна
  // добавляем постоянный сдвиг. Подобран по тестовому треку (было −13 мс систематически).
  const fps = SR / HOP, dt = 0.0305;
  // уточняем каждый удар до пика атаки в ±2 окнах
  const refined = frames.map(f => {
    let b = f;
    for (let k = Math.max(0, f - 2); k <= Math.min(env.length - 1, f + 2); k++) if (env[k] > env[b]) b = k;
    return b;
  });
  // удары в тишине до начала музыки и после конца — выбрасываем
  const strong = [...env].map((v, i) => (v > 1 ? i : -1)).filter(i => i >= 0);
  const fromF = (strong[0] ?? 0) - period / 2, toF = (strong.at(-1) ?? env.length) + period / 2;
  const kept = refined.map((f, i) => [f, i]).filter(([f]) => f >= fromF && f <= toF);
  const beats = kept.map(([f]) => +(f / fps + dt).toFixed(4)).filter(t => t >= 0);

  // «раз»: в какой фазе (по модулю 4) больше всего баса
  const bass = [0, 0, 0, 0];
  kept.forEach(([f], i) => { bass[i % 4] += Math.max(low[f] || 0, low[f + 1] || 0); });
  const onePhase = bass.indexOf(Math.max(...bass));

  const onBeat = kept.reduce((s, [f]) => s + env[f], 0) / kept.length;
  const avg = env.reduce((s, v) => s + v, 0) / env.length;
  return { beats, bpm: +((60 * fps) / period).toFixed(1), onePhase, confidence: +(onBeat / (avg || 1)).toFixed(2) };
}
