/* Экран результата: оценка, метрики фразами, таймлайн сессии. Только отрисовка —
 * всё посчитано в metrics.js.
 */

import { ZONES, WEIGHTS, scoreParts } from "./metrics.js";

const C = { good: "#79B3A5", ok: "#E8B23A", bad: "#E0654F", chalk: "#F0EDE8", dim: "#8A9296" };
const zoneColor = (ms) => (Math.abs(ms) <= ZONES.good ? C.good : Math.abs(ms) <= ZONES.ok ? C.ok : C.bad);

const PART_NAMES = {
  timing: "попадание в бит", stability: "стабильность", taps: "тапы на 4 и 8",
  ones: "направление на раз", start: "старт", tempo: "темп",
};

export function renderResult(root, m, { beats, counts, period, track }) {
  root.querySelector("#scoreVal").textContent = m.score;

  // метрики — в порядке важности для человека
  const order = ["start", "offset", "hit", "sections", "stability", "tempo", "taps", "ones", "missed"];
  const list = root.querySelector("#metricList");
  list.innerHTML = "";
  for (const k of order) {
    if (!m.text[k]) continue;
    const li = document.createElement("li");
    li.textContent = m.text[k];
    list.appendChild(li);
  }

  // как считается оценка — с долей каждой части
  const parts = scoreParts(m);
  const rows = Object.entries(WEIGHTS).map(([k, w]) => {
    const v = parts[k];
    return `<tr><td>${PART_NAMES[k]}</td><td>${w}%</td><td>${v == null ? "не измерено" : Math.round(v * 100) + " из 100"}</td></tr>`;
  }).join("");
  root.querySelector("#scoreParts").innerHTML = rows;

  root.querySelector("#timeline").innerHTML = timelineSVG(m, beats, counts, period, track);
}

/* Таймлайн: горизонтальная полоса по всей сессии. Удары — тонкие риски, «раз» — толще.
 * Шаги — точки над линией, если позже бита, и под линией, если раньше; высота — насколько.
 * Цвет — как вспышки во время танца. Тап — кольцо.
 */
const SECTION_COLORS = { intro: "#8A9296", derecho: "#79B3A5", majao: "#9C8FD0", mambo: "#E8B23A", break: "#E0654F", outro: "#8A9296" };

function timelineSVG(m, beats, counts, period, track) {
  const ev = m.matched;
  if (!ev.length) return "";
  const first = Math.max(0, Math.min(...ev.map(e => e.beat)) - 1);
  const last = Math.min(beats.length - 1, Math.max(...ev.map(e => e.beat)) + 1);
  const PX = 22, H = 150, MID = 75, AMP = 60, LIM = 250;   // ±250 мс — край полосы
  const W = (last - first) * PX + 40;
  const x = (i) => 20 + (i - first) * PX;
  const y = (ms) => MID - Math.max(-1, Math.min(1, ms / LIM)) * AMP;

  // время → x: по сетке ударов (живой трек плавает по темпу)
  const xt = (t) => {
    let i = first;
    while (i < last && beats[i + 1] <= t) i++;
    const span = (beats[i + 1] ?? beats[i] + period) - beats[i];
    return x(i) + ((t - beats[i]) / span) * PX;
  };
  const out = [];
  // части трека — цветной полосой сверху, брейки и хиты — значками
  if (track?.sections?.length) {
    track.sections.forEach((sec, k) => {
      const x0 = Math.max(0, xt(sec.start)), x1 = Math.min(W, xt(track.sections[k + 1]?.start ?? beats[last] + period));
      if (x1 <= x0) return;
      const col = SECTION_COLORS[sec.type] ?? C.dim;
      out.push(`<rect x="${x0}" y="0" width="${x1 - x0}" height="${H}" fill="${col}" opacity=".06"/>`);
      out.push(`<rect x="${x0}" y="0" width="${x1 - x0}" height="3" fill="${col}"/>`);
      out.push(`<text x="${x0 + 4}" y="14" fill="${col}" font-size="10">${sec.type}</text>`);
    });
    for (const a of track.accents || []) {
      const ax = xt(a.time);
      if (ax < 0 || ax > W) continue;
      if (a.type === "break") {
        out.push(`<rect x="${ax}" y="22" width="${Math.max(4, xt(a.time + (a.duration || 0.5)) - ax)}" height="6" rx="2" fill="${C.bad}" opacity=".8"><title>брейк</title></rect>`);
      } else {
        out.push(`<path d="M${ax} 20 l4 6 l-4 6 l-4 -6z" fill="${C.chalk}"><title>хит</title></path>`);
      }
    }
  }
  // зоны ±70 и ±150 мс
  out.push(`<rect x="0" y="${y(ZONES.ok)}" width="${W}" height="${y(-ZONES.ok) - y(ZONES.ok)}" fill="${C.ok}" opacity=".08"/>`);
  out.push(`<rect x="0" y="${y(ZONES.good)}" width="${W}" height="${y(-ZONES.good) - y(ZONES.good)}" fill="${C.good}" opacity=".12"/>`);
  out.push(`<line x1="0" y1="${MID}" x2="${W}" y2="${MID}" stroke="${C.dim}" stroke-width="1"/>`);
  for (let i = first; i <= last; i++) {
    const one = counts[i] === 1;
    out.push(`<line x1="${x(i)}" y1="${MID - (one ? 22 : 8)}" x2="${x(i)}" y2="${MID + (one ? 22 : 8)}" stroke="${one ? C.chalk : C.dim}" stroke-width="${one ? 2 : 1}"/>`);
    if (one) out.push(`<text x="${x(i)}" y="${H - 4}" fill="${C.dim}" font-size="10" text-anchor="middle">1</text>`);
  }
  for (const e of ev) {
    const cx = x(e.beat), cy = y(e.offsetMs), col = zoneColor(e.offsetMs);
    out.push(`<line x1="${cx}" y1="${MID}" x2="${cx}" y2="${cy}" stroke="${col}" stroke-width="1" opacity=".5"/>`);
    out.push(e.type === "tap"
      ? `<circle cx="${cx}" cy="${cy}" r="4.5" fill="none" stroke="${col}" stroke-width="2"><title>тап, счёт ${e.count}, ${e.offsetMs >= 0 ? "+" : ""}${e.offsetMs} мс</title></circle>`
      : `<circle cx="${cx}" cy="${cy}" r="5" fill="${col}"><title>шаг, счёт ${e.count}, ${e.offsetMs >= 0 ? "+" : ""}${e.offsetMs} мс</title></circle>`);
  }
  if (m.start) {
    const s0 = ev.find(e => Math.abs(e.t - m.start.t) < 0.03);
    if (s0) out.push(`<text x="${x(s0.beat)}" y="${track?.sections?.length ? 42 : 12}" fill="${m.start.ok ? C.good : C.ok}" font-size="10" text-anchor="middle">старт</text>`);
  }
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Таймлайн сессии: шаги относительно ударов">${out.join("")}</svg>`;
}
