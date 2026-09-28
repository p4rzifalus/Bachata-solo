/* Метрики сессии и итоговая оценка. Чистая логика, без DOM.
 *
 * events — итоговые события детектора после поправки калибровки:
 *   [{ t, foot, type: "step"|"tap", dir, beat, count, offsetMs }]
 * beats — времена всех ударов сессии; counts — счёт 1–8 для каждого;
 * period — длительность удара, с; start — итог StartCheck (или null);
 * ones — { n, ok } из StartCheck: в ту ли сторону шаг на каждом «раз».
 */

import { expectedFoot } from "./calibrate.js";

export const ZONES = { good: 70, ok: 150 };   // мс: зелёная и жёлтая зоны, как у вспышек

const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const median = (a) => {
  const s = [...a].sort((x, y) => x - y), n = s.length;
  return n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN;
};
const pct = (x, n) => (n ? Math.round((100 * x) / n) : 0);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

/* Привязка шагов к ударам. Обычно шаг относится к ближайшему удару. Но при опоздании
 * около полуудара «ближайший» — лотерея: половина шагов засчиталась бы как «раньше»,
 * и в среднем вышло бы «ровно в бит». Поэтому сначала подбираем общий сдвиг танцора:
 * при каком сдвиге ноги лучше всего совпадают с рисунком базового шага на своих счётах
 * (рисунок, сдвинутый на удар, совпадает лишь на 2 счётах из 8). От этого сдвига каждый
 * шаг и привязываем к удару. Если танцор в бит, сдвиг выходит около нуля — это та же
 * привязка к ближайшему удару.
 */
function nearestBeat(beats, t) {
  let lo = 0, hi = beats.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (beats[m] <= t) lo = m; else hi = m; }
  return Math.abs(t - beats[lo]) <= Math.abs(t - beats[hi]) ? lo : hi;
}

export function assignBeats(events, beats, counts, period, oneDir) {
  const matchAt = (lag) => events.filter(e => expectedFoot(counts[nearestBeat(beats, e.t - lag)], oneDir) === e.foot).length;
  const zero = { lag: 0, match: matchAt(0) };
  let best = zero;
  for (let lag = -period / 2; lag < period / 2; lag += 0.01) {
    const match = matchAt(lag);
    if (match > best.match || (match === best.match && Math.abs(lag) < Math.abs(best.lag))) best = { lag, match };
  }
  /* Сдвиг принимаем, только если с ним рисунок ног действительно совпадает со счётом
   * и заметно лучше, чем без сдвига. Если человек танцует не с того счёта, рисунок не
   * совпадает ни при каком сдвиге — тогда честнее ближайший удар.
   */
  const n = events.length || 1;
  if (best.match < 0.7 * n || best.match - zero.match < 0.15 * n) best = zero;
  // …и только когда сам тайминг спор не решает: если большинство шагов и так близко
  // к ударам, человек танцует по сетке, и «с какого счёта» — вопрос старта, а не сдвига.
  // (У базового шага есть внутренняя симметрия: рисунок, сдвинутый на 3 удара,
  // совпадает с исходным на 6 счётах из 8 — рисунку одному верить нельзя.)
  const onGrid = events.filter(e => Math.abs(e.t - beats[nearestBeat(beats, e.t)]) <= period / 4).length;
  if (onGrid >= 0.5 * n) best = zero;
  const assigned = events.map(e => {
    const i = nearestBeat(beats, e.t - best.lag);
    return { ...e, beat: i, count: counts[i], offsetMs: Math.round((e.t - beats[i]) * 1000) };
  });
  return { assigned, lagMs: Math.round(best.lag * 1000) };
}

export function computeMetrics({ events, beats, counts, period, start, ones, endT, oneDir = "left" }) {
  // танец считаем с первого шага (начало из StartCheck) и до конца сессии
  const t0 = start?.t ?? -Infinity, t1 = endT ?? Infinity;
  const { assigned: ev, lagMs } = assignBeats(events.filter(e => e.t >= t0 - 0.05 && e.t <= t1), beats, counts, period, oneDir);

  // старт — по той же привязке: при опоздании в полудара «с какого счёта» тоже решает рисунок ног
  if (start) {
    const s0 = ev.find(e => Math.abs(e.t - start.t) < 0.03);
    if (s0 && s0.count !== start.count) {
      const count = s0.count, want = oneDir === "left" ? "влево" : "вправо";
      const ok = count === 1 && start.dir === want;
      const verdict = count !== 1 ? `Начал с ${count} — вход должен быть на раз`
        : ok ? `Начал с раз, шаг ${start.dir} ✓` : `Начал с раз, но шагнул ${start.dir} — на раз шаг ${want}`;
      start = { ...start, count, ok, verdict, offsetMs: s0.offsetMs };
    }
  }
  const beatIdx = beats.map((b, i) => i).filter(i => beats[i] >= t0 - period / 2 && beats[i] <= t1);

  // смещение и стабильность
  const offs = ev.map(e => e.offsetMs);
  const meanMs = Math.round(mean(offs));
  const sdMs = Math.round(Math.sqrt(mean(offs.map(o => (o - meanMs) ** 2))));
  const within = (lim) => offs.filter(o => Math.abs(o) <= lim).length;
  const hit70 = pct(within(ZONES.good), offs.length);
  const hit150 = pct(within(ZONES.ok), offs.length);

  // темп: медианный интервал между соседними постановками ÷ длительность удара
  const ts = ev.map(e => e.t).sort((a, b) => a - b);
  const gaps = ts.slice(1).map((t, i) => t - ts[i]).filter(g => g > period * 0.3);
  const tempoRatio = gaps.length ? +(median(gaps) / period).toFixed(2) : NaN;

  // тапы: на 4 и 8 должен быть тап; восьмёрка засчитана, если оба на месте
  const byBeat = new Map();
  for (const e of ev) if (!byBeat.has(e.beat) || Math.abs(e.offsetMs) < Math.abs(byBeat.get(e.beat).offsetMs)) byBeat.set(e.beat, e);
  let tapSlots = 0, tapOk = 0, eights = 0, eightsOk = 0, half = null;
  for (const i of beatIdx) {
    const c = counts[i];
    if (c !== 4 && c !== 8) continue;
    tapSlots++;
    const ok = byBeat.get(i)?.type === "tap";
    if (ok) tapOk++;
    if (c === 4) half = ok;
    else if (half !== null) { eights++; if (half && ok) eightsOk++; half = null; }
  }
  const wrongTaps = ev.filter(e => e.type === "tap" && e.count !== 4 && e.count !== 8).length;

  // пропуски: удары, на которые не пришлось ни одной постановки
  const missed = beatIdx.filter(i => !byBeat.has(i)).length;

  const m = {
    matched: ev,
    lagMs,
    events: ev.length, beats: beatIdx.length, missed,
    meanMs, sdMs, hit70, hit150, tempoRatio,
    taps: { slots: tapSlots, ok: tapOk, eights, eightsOk, wrong: wrongTaps },
    start: start ?? null,
    ones: ones && ones.n ? { ...ones } : null,
  };
  m.score = score(m);
  m.text = describe(m);
  return m;
}

/* Итоговая оценка 0–100 — взвешенная сумма частей, каждая от 0 до 1:
 *   45% попадание в бит — зелёная зона считается полностью, жёлтая наполовину;
 *   15% стабильность — разброс до 40 мс даёт 1, 160 мс и больше — 0;
 *   15% тапы — доля восьмёрок, где тапы на 4 и 8 на месте;
 *   10% направление — доля «раз», где шаг в нужную сторону;
 *   10% старт — начал с раз в нужную сторону: 1; с раз не туда: 0,5; не с раз: 0;
 *    5% темп — шаги идут в темпе удара.
 * Части, которые не удалось измерить (например, ни одной восьмёрки), выпадают,
 * а веса остальных растягиваются.
 */
export const WEIGHTS = { timing: 45, stability: 15, taps: 15, ones: 10, start: 10, tempo: 5 };

export function scoreParts(m) {
  const parts = {};
  if (m.events) {
    parts.timing = clamp01((m.hit70 + (m.hit150 - m.hit70) / 2) / 100);
    parts.stability = clamp01(1 - (m.sdMs - 40) / 120);
  }
  if (m.taps.eights) parts.taps = m.taps.eightsOk / m.taps.eights;
  if (m.ones) parts.ones = m.ones.ok / m.ones.n;
  if (m.start) parts.start = m.start.ok ? 1 : m.start.count === 1 ? 0.5 : 0;
  if (Number.isFinite(m.tempoRatio)) parts.tempo = clamp01(1 - Math.abs(m.tempoRatio - 1) / 0.5);
  return parts;
}

function score(m) {
  const parts = scoreParts(m);
  let sum = 0, w = 0;
  for (const [k, v] of Object.entries(parts)) { sum += WEIGHTS[k] * v; w += WEIGHTS[k]; }
  return w ? Math.round((100 * sum) / w) : 0;
}

// Метрики — человеческими фразами.
function describe(m) {
  const out = {};
  const a = Math.abs(m.meanMs);
  out.offset = a < 20 ? "В среднем ты ровно в бит"
    : `В среднем ты на ${a} мс ${m.meanMs < 0 ? "раньше" : "позже"} бита`;
  out.stability = (m.sdMs <= 60 ? "Стабильно" : m.sdMs <= 100 ? "Немного плаваешь" : "Плаваешь") + ` · разброс ±${m.sdMs} мс`;
  out.hit = `${m.hit70}% шагов точно в бит (±${ZONES.good} мс), ${m.hit150}% — близко (±${ZONES.ok} мс)`;
  const r = m.tempoRatio;
  out.tempo = !Number.isFinite(r) ? "Темп не определить — мало шагов"
    : r > 1.7 ? `Медленнее в ${Math.round(r)} раза — шаг через удар`
    : r > 1.15 ? "Медленнее бита — не успеваешь за музыкой"
    : r < 0.85 ? "Торопишься — шагаешь быстрее бита"
    : "В темпе";
  if (m.start) out.start = m.start.ok ? `Начал с 1, шаг ${m.start.dir} ✓` : m.start.verdict;
  else out.start = "Начало танца не нашлось — шагов подряд после отсчёта было мало";
  if (m.taps.eights) {
    out.taps = `Тапы на 4 и 8 на месте в ${pct(m.taps.eightsOk, m.taps.eights)}% восьмёрок`;
    if (m.taps.wrong) out.taps += ` · ещё ${m.taps.wrong} ${plural(m.taps.wrong, "тап", "тапа", "тапов")} не на своём счёте`;
  }
  if (m.ones) out.ones = `На раз шаг в нужную сторону в ${m.ones.ok} из ${m.ones.n} восьмёрок`;
  if (m.missed) out.missed = `Не увидел шага на ${m.missed} ${plural(m.missed, "удар", "удара", "ударов")} из ${m.beats}`;
  return out;
}

function plural(n, one, few, many) {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}
