/* Прогон детектора на записи сессии — без камеры и без танца.
 * node tools/replay.mjs запись.json ['{"moveOn":1.0}']
 * Печатает события, их опоздание относительно ближайшего удара и сводку.
 */
import fs from "node:fs";
import { StepDetector, defaultSettings } from "../src/steps.js";

export function replay(rec, overrides = {}) {
  const settings = { ...defaultSettings(), ...(rec.settings || {}), ...overrides };
  const det = new StepDetector(settings);
  if (rec.bpm) det.setBeatPeriod(60 / rec.bpm);
  const events = [];
  for (const f of rec.frames) {
    const lm = f.lm ? f.lm.map(([x, y, v]) => ({ x, y, visibility: v })) : null;
    for (const m of det.update(lm, f.t, rec.videoW, rec.videoH)) if (m.kind === "event") events.push(m);
  }
  const shift = (rec.calibrationMs || 0) / 1000;
  return events.map(e => {
    const t = e.t - shift;
    let best = null;
    rec.beats.forEach((b, i) => { if (!best || Math.abs(t - b) < Math.abs(best.d)) best = { i, d: t - b }; });
    return { ...e, beat: best?.i, offsetMs: best ? Math.round(best.d * 1000) : null };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const ev = replay(rec, process.argv[3] ? JSON.parse(process.argv[3]) : {});
  for (const e of ev) console.log(`${e.t.toFixed(3)}  ${e.foot} ${e.type.padEnd(4)}  удар ${String(e.beat).padStart(3)}  ${e.offsetMs >= 0 ? "+" : ""}${e.offsetMs} мс  conf ${e.conf}  сдвиг бёдер ${e.shift}`);
  const offs = ev.map(e => e.offsetMs), m = offs.reduce((a, b) => a + b, 0) / (offs.length || 1);
  console.log(`\nсобытий: ${ev.length}, ударов в записи: ${rec.beats.length}, среднее смещение ${Math.round(m)} мс`);
}
