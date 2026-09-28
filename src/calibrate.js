/* Калибровка задержки: личная поправка «наушники + камера + реакция».
 * Человек танцует базовый шаг под метроном 16 ударов; первые 4 не считаются,
 * по остальным берётся медиана опозданий. Чистая логика, без DOM.
 *
 * Поправку меряем на том же базовом шаге, что и в танце: тогда в неё входит и то,
 * как детектор видит именно эти движения.
 */

export const CALIB = {
  beats: 16,      // сколько ударов звучит
  skip: 4,        // первые — чтобы войти в ритм, не считаются
  minHits: 8,     // меньше найденных шагов из 12 — калибровка не удалась
  maxSpread: 90,  // разброс (MAD), мс: больше — шаги слишком неровные
  minFoot: 0.75,  // доля шагов, где нога совпала с рисунком базового шага
};

// Какая стопа ставится на каждый счёт базового шага, если на раз — шаг влево.
// Если на раз шаг вправо — всё зеркально.
const FOOT_LEFT = { 1: "L", 2: "R", 3: "L", 4: "R", 5: "R", 6: "L", 7: "R", 8: "L" };
const mirror = (f) => (f === "L" ? "R" : "L");

const median = (a) => {
  const s = [...a].sort((x, y) => x - y), n = s.length;
  return n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN;
};

/* lands — [{ t, foot, dir }] по аудио-часам, без поправки;
 * beats — времена ударов; counts — счёт 1–8 для каждого; period — длительность удара, с.
 *
 * Опоздание больше полуудара неотличимо от «раньше на следующий удар». Поэтому пробуем
 * две гипотезы — постановка относится к ближайшему удару или к предыдущему — и выбираем
 * ту, где ноги на счётах совпадают с рисунком базового шага.
 */
export function computeCalibration(lands, beats, counts, period, oneDir = "left", cfg = CALIB) {
  const first = cfg.skip, last = Math.min(cfg.beats, beats.length) - 1;
  const footFor = (c) => (oneDir === "left" ? FOOT_LEFT[c] : mirror(FOOT_LEFT[c]));

  const hypothesis = (lag) => {
    const used = new Map();   // удар → постановка, ближайшая к нему
    for (const l of lands) {
      const tt = l.t - lag * period;
      let i = 0;
      for (let k = 1; k < beats.length; k++) if (Math.abs(beats[k] - tt) < Math.abs(beats[i] - tt)) i = k;
      if (i < first || i > last) continue;
      const off = l.t - beats[i];
      if (Math.abs(off - lag * period) > period / 2) continue;
      const prev = used.get(i);
      if (!prev || Math.abs(off - lag * period) < Math.abs(prev.off - lag * period)) used.set(i, { off, foot: l.foot, i });
    }
    const hits = [...used.values()];
    const match = hits.filter(h => h.foot === footFor(counts[h.i])).length;
    return { lag, hits, match };
  };

  const h0 = hypothesis(0), h1 = hypothesis(1);
  const best = h1.match > h0.match ? h1 : h0;
  const offs = best.hits.map(h => h.off * 1000);
  const ms = Math.round(median(offs));
  const spread = Math.round(median(offs.map(o => Math.abs(o - ms))));
  const expected = last - first + 1;

  let ok = true, reason = "";
  const wantFoot = oneDir === "left" ? "левой влево" : "правой вправо";
  if (best.hits.length < cfg.minHits) { ok = false; reason = `Увидел ${best.hits.length} шагов из ${expected} — попробуй ещё раз, целиком в кадре`; }
  else if (best.match < cfg.minFoot * best.hits.length) { ok = false; reason = `Шаги не совпали со счётом — начни на раз ${wantFoot} и попробуй ещё раз`; }
  else if (spread > cfg.maxSpread) { ok = false; reason = `Шаги слишком неровные (разброс ${spread} мс) — попробуй ещё раз, спокойно в такт`; }

  return { ok, ms, spread, hits: best.hits.length, expected, footMatch: best.match, lateBeat: best.lag === 1, reason };
}
