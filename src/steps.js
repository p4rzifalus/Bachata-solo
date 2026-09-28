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
  moveOn:      { v: 0.4,  min: 0.1,  max: 3,    step: 0.05, label: "Стопа поехала: скорость выше, торсов/с" },
  stopOff:     { v: 0.5, min: 0.05, max: 1.5,  step: 0.05, label: "Стопа встала: скорость ниже, торсов/с" },
  settleMs:    { v: 30,   min: 0,    max: 200,  step: 10,   label: "Сколько стопа должна стоять, мс" },
  arriveEps:   { v: 0.05, min: 0.01, max: 0.2,  step: 0.01, label: "Момент постановки: стопа ближе к месту, чем, торсов" },
  minTravel:   { v: 0.1, min: 0.02, max: 0.6,  step: 0.01, label: "Минимальный путь стопы, торсов" },
  touchRev:    { v: 0.3,  min: 0.05, max: 2,    step: 0.05, label: "Касание: стопа развернулась назад быстрее, торсов/с" },
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
    this.hipHist = [];
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
   *   { kind: "event", foot, t, type, conf, dir, ... } — итог: шаг или тап (к следующей постановке);
   *     dir — куда ехала стопа в кадре камеры: +1 вправо по картинке, −1 влево
   *     (для человека лицом к камере +1 — это его левая сторона)
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
    this.hipHist.push([t, hipX]);
    while (this.hipHist.length && t - this.hipHist[0][0] > 2) this.hipHist.shift();

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

    /* Шаг или тап. На ногу, на которой стоишь, тапнуть нельзя: если следующей
     * встала та же стопа — веса на ней не было, это тап; если другая — шаг.
     * Поэтому итог приходит к следующей постановке (обычно через удар).
     */
    const landed = out.filter(m => m.kind === "land");
    this.pending = this.pending.filter(p => {
      const next = landed.find(m => m.t > p.t);
      const timeout = t - p.t > 2.5 * this.beatPeriod;
      if (!next && !timeout) return true;
      out.push({
        kind: "event", foot: p.foot, t: p.t, dir: p.dir, how: p.how,
        type: next && next.foot === p.foot ? "tap" : "step",
        conf: p.conf, travel: +p.travel.toFixed(3),
      });
      return false;
    });
    for (const m of landed) this.pending.push(m.pending);
    return out;
  }

  hipAt(tq) {
    const h = this.hipHist;
    for (let i = h.length - 1; i >= 0; i--) if (h[i][0] <= tq) return h[i][1];
    return h.length ? h[0][1] : 0;
  }

  stepFoot(side, fx, fy, vis, hipX, t, out) {
    const F = this.feet[side], s = this.s;

    // высота над полом — только для графика: в базовом шаге стопа почти не поднимается,
    // и по камере эта высота тонет в дрожи точек, поэтому в решениях она не участвует
    F.hist.push([t, fy]);
    while (F.hist.length && t - F.hist[0][0] > 1.5) F.hist.shift();
    const lift = Math.max(0, Math.max(...F.hist.map(p => p[1])) - fy);

    // скорость — по сдвигу за ~3 кадра: заметно меньше шума, чем от кадра к кадру
    F.track.push([t, fx, fy]);
    if (F.track.length > 3) F.track.shift();
    let speed = 0, vx = 0;
    if (F.track.length > 1) {
      const [t0, x0, y0] = F.track[0], dt = Math.max(1e-3, t - t0);
      speed = Math.hypot(fx - x0, fy - y0) / dt;
      vx = (fx - x0) / dt;
    }

    if (F.state === "planted") {
      if (speed > s.moveOn) this.startMove(F, t, fx, hipX, vis);
    } else {
      const M = F.move;
      if (F.prev) M.travel += Math.hypot(fx - F.prev.x, fy - F.prev.y);
      M.vis = Math.min(M.vis, vis);
      const disp = fx - M.x0;
      if (!M.dir && Math.abs(disp) >= s.minTravel / 2) M.dir = Math.sign(disp);

      if (speed < s.stopOff) {
        // встала и стоит — обычная постановка
        if (F.still == null) {
          const ps = F.prev?.speed ?? speed;
          const frac = ps > speed ? (ps - s.stopOff) / (ps - speed) : 1;
          F.still = F.prev ? F.prev.t + Math.min(1, Math.max(0, frac)) * (t - F.prev.t) : t;
        }
        if (t - F.still >= s.settleMs / 1000) {
          this.land(side, this.arrival(F, M.start) ?? F.still, M, "settle", out);
          F.state = "planted"; F.move = null; F.still = null;
        }
      } else if (M.dir && vx * M.dir < -s.touchRev && Math.abs(disp) >= s.minTravel) {
        // коснулась и сразу поехала обратно — так выглядит тап: момент — крайняя точка
        const tip = this.extreme(F, M.start, M.dir);
        this.land(side, tip.t, M, "touch", out);
        this.startMove(F, tip.t, tip.x, hipX, vis);
      } else {
        F.still = null;
        if (t - M.start > 1.5) { F.state = "planted"; F.move = null; }   // не встала — сбрасываем
      }
    }

    F.prev = { t, x: fx, y: fy, speed };
    return { lift, speed, x: fx, state: F.state };
  }

  startMove(F, t, x, hipX, vis) {
    F.state = "moving";
    F.move = { start: t, x0: x, dir: 0, travel: 0, vis };
    F.still = null;
  }

  // Крайняя точка по горизонтали в направлении dir — по несглаженным точкам.
  extreme(F, since, dir) {
    const raw = F.raw.filter(p => p[0] >= since);
    let best = null;
    raw.forEach((p, i) => {
      const a = raw[Math.max(0, i - 1)], b = raw[Math.min(raw.length - 1, i + 1)];
      const x = (a[1] + p[1] + b[1]) / 3;
      if (!best || x * dir > best.x * dir) best = { t: p[0], x };
    });
    return best ?? { t: F.prev.t, x: F.prev.x };
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

  land(side, tLand, M, how, out) {
    if (M.travel < this.s.minTravel) return;                                   // дрожь, а не шаг
    if (tLand - this.lastEvent[side] < this.s.refractory * this.beatPeriod) return;  // дубль
    this.lastEvent[side] = tLand;
    const conf = +(Math.min(1, M.vis) * Math.min(1, M.travel / (2 * this.s.minTravel))).toFixed(2);
    out.push({ kind: "land", foot: side, t: tLand, dir: M.dir || 1,
      pending: { foot: side, t: tLand, dir: M.dir || 1, how, conf, travel: M.travel } });
  }
}
