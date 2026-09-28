/* Синтетическая запись базового шага — для проверки детектора без камеры.
 * node tools/synth.mjs [bpm] [опоздание_мс] [шум] > rec.json
 * Формат тот же, что у «Скачать данные» в отладочном режиме.
 */
export function synthRecording({ bpm = 120, lateMs = 30, noise = 0.004, seconds = 20, fps = 30, seed = 1 } = {}) {
  let r = seed;
  const rnd = () => (r = (r * 16807) % 2147483647) / 2147483647;
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());

  const P = 60 / bpm, W = 720, H = 1280;
  const beats = Array.from({ length: Math.floor(seconds / P) }, (_, i) => 1 + i * P);
  // Метры → доли кадра: человек ростом ~1.7 м занимает ~80% высоты
  const mx = (m) => 0.5 + m * 0.47 * H / W / 1.7 * 0.8, my = (m) => 0.9 - m * 0.8 / 1.7;

  // план: для каждого удара — какая стопа, куда, шаг или тап
  const pos = { L: -0.12, R: 0.12 }, plan = [];
  const pattern = [
    ["L", -0.3, "step"], ["R", 0, "close"], ["L", -0.3, "step"], ["R", 0, "tap"],
    ["R", +0.3, "step"], ["L", 0, "close"], ["R", +0.3, "step"], ["L", 0, "tap"],
  ];
  beats.forEach((b, i) => {
    const [foot, dx, kind] = pattern[i % 8];
    const other = foot === "L" ? "R" : "L";
    const from = pos[foot];
    const to = kind === "step" ? from + dx : kind === "close" ? pos[other] + (foot === "L" ? -0.14 : 0.14) : from;
    plan.push({ foot, from, to, kind, land: b + lateMs / 1000, weight: kind !== "tap" ? foot : null });
    pos[foot] = to;
  });

  const ease = (u) => u <= 0 ? 0 : u >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * u);
  const frames = [];
  for (let t = 0; t < seconds; t += 1 / fps + (rnd() - 0.5) * 0.004) {
    const foot = { L: { x: -0.12, lift: 0 }, R: { x: 0.12, lift: 0 } };
    let weightFoot = "L", hipFrom = null, hipBlend = 1;
    const cur = { L: -0.12, R: 0.12 };
    for (const p of plan) {
      const dur = P * 0.45, start = p.land - dur;
      if (t >= p.land) { cur[p.foot] = p.to; foot[p.foot] = { x: p.to, lift: 0 }; }
      else if (t > start) {
        const u = (t - start) / dur;
        const x = p.kind === "tap" ? p.from + 0.05 * Math.sin(Math.PI * u) * (p.foot === "L" ? -1 : 1) : p.from + (p.to - p.from) * ease(u);
        foot[p.foot] = { x, lift: (p.kind === "tap" ? 0.035 : 0.05) * Math.sin(Math.PI * u) };
        cur[p.foot] = x;
      }
    }
    for (const f of ["L", "R"]) foot[f].x = cur[f];
    // бёдра идут за опорной ногой с задержкой ~0.2 с после постановки
    let hip = 0, lastW = null;
    for (const p of plan) if (p.weight && t >= p.land - 0.05) lastW = p;
    if (lastW) {
      const u = ease((t - (lastW.land - 0.05)) / 0.25);
      const target = 0.7 * cur[lastW.foot] + 0.3 * cur[lastW.foot === "L" ? "R" : "L"];
      const prevT = plan.filter(p => p.weight && p.land < lastW.land).at(-1);
      const prevTarget = prevT ? 0.7 * prevT.to + 0.3 * cur[prevT.foot === "L" ? "R" : "L"] : 0;
      hip = prevTarget + (target - prevTarget) * u;
    }
    const lm = Array.from({ length: 33 }, () => [0.5, 0.5, 0.95]);
    const set = (i, x, y, n = noise) => lm[i] = [+(mx(x) + gauss() * n).toFixed(5), +(my(y) + gauss() * n).toFixed(5), 0.95];
    set(0, hip, 1.6); set(11, hip - 0.2, 1.42); set(12, hip + 0.2, 1.42);
    set(23, hip - 0.13, 0.95); set(24, hip + 0.13, 0.95);
    for (const [f, a, k, h, toe] of [["L", 27, 25, 29, 31], ["R", 28, 26, 30, 32]]) {
      const x = foot[f].x, y = foot[f].lift;
      set(k, (x + (f === "L" ? hip - 0.13 : hip + 0.13)) / 2, 0.5 + y / 2);
      set(a, x, 0.08 + y, noise * 1.5); set(h, x, 0.03 + y, noise * 1.5); set(toe, x, 0.0 + y, noise * 1.5);
    }
    frames.push({ t: +t.toFixed(4), lm });
  }
  return { version: 1, synthetic: true, bpm, videoW: W, videoH: H, calibrationMs: 0, lateMs,
    beats, plan: plan.map(p => ({ foot: p.foot, t: p.land, type: p.kind === "tap" ? "tap" : "step" })), frames, events: [] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [bpm, late, noise] = process.argv.slice(2).map(Number);
  process.stdout.write(JSON.stringify(synthRecording({ bpm: bpm || 120, lateMs: late ?? 30, noise: noise || 0.004 })));
}
