/* Живой график отладки за последние 5 секунд:
 * высота обеих стоп, горизонтальная позиция бёдер, удары и распознанные события.
 * Время по оси X — аудио-часы, как и у всего остального.
 */

const WINDOW = 5;   // секунд на экране
const C = { L: "#79B3A5", R: "#E8B23A", hip: "#F0EDE8", grid: "rgba(240,237,232,.14)", beat: "rgba(240,237,232,.35)", one: "rgba(121,179,165,.85)", text: "#8A9296" };

export class LiveChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.samples = [];   // { t, L, R, hip }
    this.marks = [];     // { t, foot, kind: land|step|tap }
  }

  clear() { this.samples = []; this.marks = []; }
  push(t, sample) {
    this.samples.push({ t, L: sample.L.lift, R: sample.R.lift, hip: sample.hipX });
    this.trim(t);
  }
  mark(t, foot, kind) { this.marks.push({ t, foot, kind }); }
  trim(now) {
    while (this.samples.length && this.samples[0].t < now - WINDOW - 1) this.samples.shift();
    while (this.marks.length && this.marks[0].t < now - WINDOW - 1) this.marks.shift();
  }

  /* beats — [{ t, count }] в окне; now — текущее время по аудио-часам. */
  draw(now, beats = []) {
    const cv = this.canvas, dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = "rgba(23,26,28,.82)"; g.fillRect(0, 0, W, H);

    const x = (t) => (t - (now - WINDOW)) / WINDOW * W;
    const liftH = H * 0.55, hipTop = H * 0.62, hipH = H * 0.34;
    const yLift = (v) => liftH - Math.min(1, v / 0.4) * (liftH - 14);   // 0…0.4 торса
    const hips = this.samples.map(s => s.hip);
    const hipMid = hips.length ? (Math.max(...hips) + Math.min(...hips)) / 2 : 0;
    const yHip = (v) => hipTop + hipH / 2 - Math.max(-1, Math.min(1, (v - hipMid) / 0.5)) * hipH / 2;

    // сетка и удары
    g.strokeStyle = C.grid; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, liftH + .5); g.lineTo(W, liftH + .5); g.stroke();
    for (const b of beats) {
      const bx = Math.round(x(b.t)) + .5;
      g.strokeStyle = b.count === 1 ? C.one : C.beat;
      g.lineWidth = b.count === 1 ? 2 : 1;
      g.beginPath(); g.moveTo(bx, 0); g.lineTo(bx, H); g.stroke();
      g.fillStyle = C.text; g.font = "10px ui-monospace,monospace";
      g.fillText(b.count, bx + 3, H - 4);
    }

    // линии
    const line = (key, y, color) => {
      g.strokeStyle = color; g.lineWidth = 1.5; g.beginPath();
      this.samples.forEach((s, i) => { const px = x(s.t), py = y(s[key]); i ? g.lineTo(px, py) : g.moveTo(px, py); });
      g.stroke();
    };
    line("L", yLift, C.L);
    line("R", yLift, C.R);
    line("hip", yHip, C.hip);

    // события: риска — стопа встала; круг — шаг; кольцо — тап
    for (const m of this.marks) {
      const mx = x(m.t), color = C[m.foot];
      if (m.kind === "land") {
        g.strokeStyle = color; g.lineWidth = 2;
        g.beginPath(); g.moveTo(mx, liftH - 12); g.lineTo(mx, liftH + 2); g.stroke();
      } else {
        g.beginPath(); g.arc(mx, 10, 5, 0, Math.PI * 2);
        if (m.kind === "step") { g.fillStyle = color; g.fill(); }
        else { g.strokeStyle = color; g.lineWidth = 2; g.stroke(); }
      }
    }

    g.fillStyle = C.text; g.font = "10px ui-monospace,monospace";
    g.fillText("подъём стоп: L", 6, 28); g.fillStyle = C.L; g.fillRect(90, 22, 10, 3);
    g.fillStyle = C.text; g.fillText("R", 106, 28); g.fillStyle = C.R; g.fillRect(116, 22, 10, 3);
    g.fillStyle = C.text; g.fillText("бёдра ←→", 6, hipTop + 10);
  }
}
