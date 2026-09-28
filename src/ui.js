/* Всё, что рисует и звучит. Логики здесь нет. */

import { audio } from "./audio.js";

// Кости скелета: пары номеров точек MediaPipe Pose (без лица и кистей).
const BONES = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [29, 31], [27, 31],
  [28, 30], [30, 32], [28, 32],
];
const JOINTS = [...new Set(BONES.flat())];

export const COLORS = { chalk: "#F0EDE8", teal: "#79B3A5", amber: "#E8B23A", dim: "#8A9296" };

export class UI {
  constructor() {
    this.video    = document.getElementById("cam");
    this.canvas   = document.getElementById("overlay");
    this.ctx      = this.canvas.getContext("2d");
    this.hintEl   = document.getElementById("hint");
    this.holdEl   = document.getElementById("hold");
    this.holdFill = document.getElementById("holdFill");
    this.fpsEl    = document.getElementById("fps");
    this.mirrored = true;
  }

  setMirrored(v) { this.mirrored = v; document.body.classList.toggle("mirrored", v); }
  show(screen)   { document.body.dataset.screen = screen; }

  // Холст живёт в координатах кадра камеры и растягивается так же, как видео (object-fit: contain),
  // поэтому точки ложатся ровно на тело.
  resize(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
  }
  clear() { this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); }

  // missing — точки, которые не прошли проверку кадра; они подсвечиваются жёлтым.
  drawSkeleton(lm, tone, missing = new Set()) {
    const w = this.canvas.width, h = this.canvas.height, ctx = this.ctx;
    ctx.lineWidth = Math.max(2, w / 220);
    ctx.lineCap = "round";
    for (const [a, b] of BONES) {
      const p = lm[a], q = lm[b];
      if (!p || !q) continue;
      ctx.strokeStyle = missing.has(a) || missing.has(b) ? "rgba(232,178,58,.45)" : tone;
      ctx.beginPath(); ctx.moveTo(p.x * w, p.y * h); ctx.lineTo(q.x * w, q.y * h); ctx.stroke();
    }
    const r = Math.max(3, w / 200);
    for (const i of JOINTS) {
      const p = lm[i]; if (!p) continue;
      ctx.fillStyle = missing.has(i) ? COLORS.amber : COLORS.chalk;
      ctx.beginPath(); ctx.arc(p.x * w, p.y * h, r, 0, Math.PI * 2); ctx.fill();
    }
  }

  hint(html, tone = "") { this.hintEl.innerHTML = html; this.hintEl.className = tone; }
  hold(p) {
    this.holdEl.classList.toggle("on", p > 0 && p < 1);
    this.holdFill.style.width = Math.min(100, p * 100) + "%";
  }
  fps(text) { if (this.fpsEl) this.fpsEl.textContent = text; }

  beep(freq, ms) {
    try {
      const a = audio(), t = a.currentTime;
      const o = a.createOscillator(), g = a.createGain();
      o.type = "sine"; o.frequency.value = freq;
      g.gain.setValueAtTime(.001, t);
      g.gain.exponentialRampToValueAtTime(.25, t + .01);
      g.gain.exponentialRampToValueAtTime(.001, t + ms / 1000);
      o.connect(g); g.connect(a.destination);
      o.start(t); o.stop(t + ms / 1000);
    } catch (e) {}
  }
}
