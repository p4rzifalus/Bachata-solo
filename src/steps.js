/* Детекция шагов. Чистая логика: на вход — точки позы и время кадра по аудио-часам,
 * на выход — события «стопа встала» и «шаг/тап». Ни DOM, ни камеры — поэтому тот же код
 * прогоняется на записанных сессиях (tools/replay.mjs).
 *
 * Все расстояния — в длинах торса (плечи–бёдра), скорости — в длинах торса в секунду.
 */

// Все пороги детекции. Слайдеры в отладочной панели строятся из этого объекта.
export const DETECT_META = {
  minCutoff:   { v: 2.5,  min: 0.1,  max: 8,    step: 0.1,  label: "Сглаживание: базовый срез, Гц (меньше — плавнее, но запаздывает)" },
  beta:        { v: 1.0,  min: 0,    max: 5,    step: 0.1,  label: "Сглаживание: реакция на быстрое движение" },
  moveOn:      { v: 0.5,  min: 0.1,  max: 3,    step: 0.05, label: "Стопа поехала: скорость выше, торсов/с" },
  stopOff:     { v: 0.35, min: 0.05, max: 1.5,  step: 0.05, label: "Стопа встала: скорость ниже, торсов/с" },
  settleMs:    { v: 60,   min: 0,    max: 200,  step: 10,   label: "Сколько стопа должна стоять, мс" },
  arriveEps:   { v: 0.05, min: 0.01, max: 0.2,  step: 0.01, label: "Момент постановки: стопа ближе к месту, чем, торсов" },
  minTravel:   { v: 0.06, min: 0.02, max: 0.6,  step: 0.01, label: "Минимальный путь стопы, торсов" },
  liftFloor:   { v: 0.08, min: 0.01, max: 0.3,  step: 0.01, label: "Стопа у пола: подъём не больше, торсов" },
  landRatio:   { v: 0.5,  min: 0.1,  max: 1,    step: 0.05, label: "Стопа опустилась: подъём не больше доли от пика" },
  floorMs:     { v: 1500, min: 500,  max: 4000, step: 100,  label: "Окно поиска пола, мс" },
  weightShift: { v: 0.05, min: 0,    max: 0.4,  step: 0.01, label: "Шаг, а не тап: бёдра сместились к стопе, торсов" },
  weightMs:    { v: 220,  min: 80,   max: 500,  step: 10,   label: "Окно проверки переноса веса, мс" },
  refractory:  { v: 0.6,  min: 0.2,  max: 1,    step: 0.05, label: "Защита от дублей: доля удара" },
};

export const defaultSettings = () =>
  Object.fromEntries(Object.entries(DETECT_META).map(([k, m]) => [k, m.v]));

const IDX = {
  L: { foot: [27, 29, 31] },   // голеностоп, пятка, носок — средняя точка устойчивее любой одной
  R: { foot: [28, 30, 32] },
  shoulders: [11, 12],
  hips: [23, 24],
};

/* ─── фильтр One Euro: при медленном движении сильно сглаживает дрожь,
 *     при быстром — почти не запаздывает. ─── */
const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
class OneEuro {
  constructor(s) { this.s = s; this.x = null; this.dx = 0; this.t = null; }
  reset() { this.x = null; this.t = null; this.dx = 0; }
  filter(x, t) {
    if (this.x == null) { this.x = x; this.t = t; return x; }
    const dt = Math.max(1e-3, t - this.t); this.t = t;
    const dx = (x - this.x) / dt;
    this.dx += alpha(1, dt) * (dx - this.dx);
    const cutoff = this.s.minCutoff + this.s.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (x - this.x);
    return this.x;
  }
}

const mean = (lm, idxs, k) => idxs.reduce((s, i) => s + lm[i][k], 0) / idxs.length;

export class StepDetector {
  constructor(settings = defaultSettings()) {
    this.s = settings;
    this.beatPeriod = 60 / 128;
    this.reset();
  }

  setBeatPeriod(sec) { this.beatPeriod = sec; }

  reset() {
    this.scale = null;
    this.filters = {};
    this.feet = { L: this.freshFoot(), R: this.freshFoot() };
    this.pending = [];
    this.lastEvent = { L: -Infinity, R: -Infinity };
    this.sample = null;
  }

  freshFoot() {
    return { state: "planted", prev: null, hist: [], raw: [], track: [], still: null, move: null };
  }

  f(key, x, t) {
    const fl = this.filters[key] || (this.filters[key] = new OneEuro(this.s));
    return fl.filter(x, t);
  }

  /* lm — 33 точки MediaPipe (x, y в долях кадра, visibility), t — время кадра в секундах
   * по аудио-часам, w/h — размер кадра в пикселях (иначе на неквадратном кадре врут расстояния).
   * Возвращает массив новых сообщений:
   *   { kind: "land",  foot, t }                      — стопа встала (сразу, для вспышки)
   *   { kind: "event", foot, t, type, conf, ... }     — итог: шаг или тап (через weightMs)
   */
  update(lm, t, w, h) {
    const out = [];
    if (!lm) { this.reset(); return out; }

    // масштаб: длина торса в пикселях, медленно усредняется
    const sx = mean(lm, IDX.shoulders, "x") * w, sy = mean(lm, IDX.shoulders, "y") * h;
    const hx = mean(lm, IDX.hips, "x") * w,      hy = mean(lm, IDX.hips, "y") * h;
    const torso = Math.hypot(sx - hx, sy - hy);
    if (!torso) return out;
    this.scale = this.scale == null ? torso : this.scale + 0.05 * (torso - this.scale);
    const k = 1 / this.scale;

    const hipX = this.f("hipX", hx * k, t);
    this.sample = { t, hipX };

    for (const side of ["L", "R"]) {
      const idx = IDX[side].foot;
      const rx = mean(lm, idx, "x") * w * k, ry = mean(lm, idx, "y") * h * k;
      const fx = this.f(side + "x", rx, t);
      const fy = this.f(side + "y", ry, t);
      const vis = mean(lm, idx, "visibility");
      const F = this.feet[side];
      F.raw.push([t, rx, ry]);
      while (F.raw.length && t - F.raw[0][0] > 1) F.raw.shift();
      this.sample[side] = this.stepFoot(side, fx, fy, vis, hipX, t, out);
    }

    // классификация шаг/тап — когда прошло окно проверки переноса веса
    this.pending = this.pending.filter(p => {
      if (t - p.t < this.s.weightMs / 1000) return true;
      const shift = (hipX - p.hipX0) * p.dir;
      out.push({
        kind: "event", foot: p.foot, t: p.t,
        type: shift >= this.s.weightShift ? "step" : "tap",
        conf: p.conf, shift: +shift.toFixed(3), travel: +p.travel.toFixed(3),
      });
      return false;
    });
    return out;
  }

  stepFoot(side, fx, fy, vis, hipX, t, out) {
    const F = this.feet[side], s = this.s;

    // пол — самая низкая точка стопы за последние floorMs (y растёт вниз)
    F.hist.push([t, fy]);
    while (F.hist.length && t - F.hist[0][0] > s.floorMs / 1000) F.hist.shift();
    const floor = Math.max(...F.hist.map(p => p[1]));
    const lift = Math.max(0, floor - fy);

    // скорость — по сдвигу за ~3 кадра: заметно меньше шума, чем от кадра к кадру
    F.track.push([t, fx, fy]);
    if (F.track.length > 3) F.track.shift();
    let speed = 0;
    if (F.track.length > 1) {
      const [t0, x0, y0] = F.track[0];
      speed = Math.hypot(fx - x0, fy - y0) / Math.max(1e-3, t - t0);
    }

    if (F.state === "planted") {
      if (speed > s.moveOn) {
        F.state = "moving";
        F.move = { start: t, travel: 0, peakSpeed: speed, peakLift: lift, hipX0: hipX, vis };
        F.still = null;
      }
    } else {
      const M = F.move;
      if (F.prev) M.travel += Math.hypot(fx - F.prev.x, fy - F.prev.y);
      M.peakSpeed = Math.max(M.peakSpeed, speed);
      M.peakLift = Math.max(M.peakLift, lift);
      M.vis = Math.min(M.vis, vis);

      // у тапа стопа замирает и в верхней точке — поэтому ещё и «опустилась от пика»
      if (speed < s.stopOff && lift < s.liftFloor && lift <= M.peakLift * s.landRatio + 0.01) {
        if (F.still == null) {
          // момент остановки — точка пересечения порога между прошлым и этим кадром
          const ps = F.prev?.speed ?? speed;
          const frac = ps > speed ? (ps - s.stopOff) / (ps - speed) : 1;
          F.still = F.prev ? F.prev.t + Math.min(1, Math.max(0, frac)) * (t - F.prev.t) : t;
        }
        if (t - F.still >= s.settleMs / 1000) {
          this.land(side, this.arrival(F, M.start) ?? F.still, fx, M, out);
          F.state = "planted"; F.move = null; F.still = null;
        }
      } else {
        F.still = null;
        if (t - M.start > 1.5) { F.state = "planted"; F.move = null; }   // не встала — сбрасываем
      }
    }

    F.prev = { t, x: fx, y: fy, speed };
    return { lift, speed, x: fx, state: F.state };
  }

  /* Момент постановки задним числом, по несглаженным точкам: последний момент,
   * когда стопа была дальше arriveEps от места, где встала. Сглаживание сюда
   * не попадает, поэтому нет его запаздывания.
   */
  arrival(F, since) {
    const raw = F.raw.filter(p => p[0] >= since - 0.1);
    if (raw.length < 5) return null;
    const sm = raw.map((p, i) => {                     // среднее по 3 соседним кадрам — против дрожи
      const a = raw[Math.max(0, i - 1)], b = raw[Math.min(raw.length - 1, i + 1)];
      return [p[0], (a[1] + p[1] + b[1]) / 3, (a[2] + p[2] + b[2]) / 3];
    });
    const tail = sm.slice(-3);
    const rx = tail.reduce((s, p) => s + p[1], 0) / tail.length;
    const ry = tail.reduce((s, p) => s + p[2], 0) / tail.length;
    const d = sm.map(p => Math.hypot(p[1] - rx, p[2] - ry));
    for (let i = d.length - 1; i > 0; i--) {
      if (d[i - 1] > this.s.arriveEps && d[i] <= this.s.arriveEps) {
        const u = (d[i - 1] - this.s.arriveEps) / (d[i - 1] - d[i]);
        return sm[i - 1][0] + u * (sm[i][0] - sm[i - 1][0]);
      }
    }
    return null;
  }

  land(side, tLand, fx, M, out) {
    if (M.travel < this.s.minTravel) return;                                   // дрожь, а не шаг
    if (tLand - this.lastEvent[side] < this.s.refractory * this.beatPeriod) return;  // дубль
    this.lastEvent[side] = tLand;
    const conf = +(Math.min(1, M.vis) * Math.min(1, M.travel / (2 * this.s.minTravel))).toFixed(2);
    out.push({ kind: "land", foot: side, t: tLand });
    this.pending.push({
      foot: side, t: tLand, hipX0: M.hipX0, dir: Math.sign(fx - M.hipX0) || 1,
      conf, travel: M.travel,
    });
  }
}
