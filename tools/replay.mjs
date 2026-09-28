/* Прогон детектора на записи сессии — без камеры и без танца.
 * node tools/replay.mjs запись.json ['{"moveOn":1.0}'] [--as-recorded]
 * По умолчанию — текущие пороги из src/steps.js; --as-recorded — те, что стояли во время записи.
 * Печатает события, их опоздание относительно ближайшего удара и сводку.
 */
import fs from "node:fs";
import { StepDetector, defaultSettings } from "../src/steps.js";
import { StartCheck } from "../src/start.js";
import { computeMetrics } from "../src/metrics.js";

export function replay(rec, overrides = {}, asRecorded = false) {
  const settings = { ...defaultSettings(), ...(asRecorded ? rec.settings : {}), ...overrides };
  const det = new StepDetector(settings);
  if (rec.bpm) det.setBeatPeriod(60 / rec.bpm);
  const shift = (rec.calibrationMs || 0) / 1000;
  const nearest = (t) => {
    let best = null;
    rec.beats.forEach((b, i) => { if (!best || Math.abs(t - b) < Math.abs(best.d)) best = { i, d: t - b }; });
    return best;
  };
  const events = [], lands = [];
  for (const f of rec.frames) {
    const lm = f.lm ? f.lm.map(([x, y, v]) => ({ x, y, visibility: v })) : null;
    for (const m of det.update(lm, f.t, rec.videoW, rec.videoH)) (m.kind === "event" ? events : lands).push(m);
  }
  const out = events.map(e => {
    const t = e.t - shift, best = nearest(t);
    return { ...e, t, beat: best?.i, count: rec.counts?.[best?.i], offsetMs: best ? Math.round(best.d * 1000) : null };
  });
  out.lands = lands.map(m => {
    const t = m.t - shift, best = nearest(t);
    return { t, dir: m.dir, conf: m.pending.conf, count: rec.counts?.[best.i], countIn: best.i < (rec.countStartIndex ?? 0), offsetMs: best.d * 1000 };
  });
  return out;
}

// Метрики сессии так же, как их считает экран результата.
export function sessionMetrics(rec, ev) {
  const period = 60 / rec.bpm, ci = rec.countStartIndex ?? 0;
  const sc = new StartCheck(rec.oneDir || "left", rec.beats[ci], period);
  for (const l of ev.lands) sc.push(l);
  return computeMetrics({ events: ev, beats: rec.beats, counts: rec.counts, period, start: sc.start, ones: sc.ones, endT: rec.frames.at(-1)?.t, oneDir: rec.oneDir || "left" });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const args = process.argv.slice(3);
  const ov = args.find(a => a.startsWith("{"));
  const ev = replay(rec, ov ? JSON.parse(ov) : {}, args.includes("--as-recorded"));
  const counts = rec.counts || [];
  for (const e of ev) console.log(`${e.t.toFixed(3)}  ${e.foot} ${e.type.padEnd(4)} ${e.dir > 0 ? "→ влево " : "→ вправо"}  удар ${String(e.beat).padStart(3)}${counts[e.beat] ? " (счёт " + counts[e.beat] + ")" : ""}  ${e.offsetMs >= 0 ? "+" : ""}${e.offsetMs} мс  conf ${e.conf}`);
  const m = sessionMetrics(rec, ev);
  console.log(`\nсобытий: ${ev.length}, ударов в записи: ${rec.beats.length}\nоценка ${m.score}`);
  for (const line of Object.values(m.text)) console.log("  " + line);
}
