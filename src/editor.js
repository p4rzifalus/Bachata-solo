/* Редактор разметки: волна, автоматическая первичная разметка, ручная правка,
 * «здесь раз», тапы, части и акценты, проверка на слух, экспорт.
 * Счёт считается тем же beatCounts, что и на экране танца, — одна и та же разметка
 * даёт одинаковый счёт и там, и тут.
 */

import { audio, masterOut, perfToAudio } from "./audio.js";
import { BeatPlayer } from "./player.js";
import { beatCounts, beatIndexAt } from "./beatmap.js";
import { detectBeats } from "./beattrack.js";
import { SECTION_TYPES, fmt } from "./markup.js";

const $ = (id) => document.getElementById(id);
const wave = $("wave"), over = $("overview"), statusEl = $("status");
const SEC_COLORS = { intro: "#8A9296", derecho: "#79B3A5", majao: "#9C8FD0", mambo: "#E8B23A", break: "#E0654F", outro: "#8A9296" };

const ed = {
  buffer: null, audioName: "", duration: 0, peaks: null, PPS: 200,   // пиков в секунду
  beats: [], anchors: [],          // anchors — номера ударов, которые человек назначил «раз»
  sections: [], accents: [], danceStart: null,
  sel: null, cursor: 0, view: { start: 0, dur: 20 },
  taps: [], tapping: false, dirty: false,
};
let player = null, playMode = null;   // null | "play" | "check"

/* ─── состояние → разметка ─── */

// «Раз»: от каждого назначенного вручную — каждые 8 ударов до следующего назначенного.
// Так можно поправить сдвиг фразы в середине трека, не трогая начало.
function downIdx() {
  const n = ed.beats.length, a = [...new Set(ed.anchors)].filter(i => i >= 0 && i < n).sort((x, y) => x - y);
  if (!a.length) return [];
  const out = [];
  for (let i = a[0] - 8; i >= 0; i -= 8) out.unshift(i);
  a.forEach((x, k) => { const end = a[k + 1] ?? n; for (let i = x; i < end; i += 8) out.push(i); });
  return out;
}

function median(a) { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }

function markup() {
  const beats = ed.beats.map(b => +b.toFixed(4));
  const downbeats = downIdx().map(i => beats[i]);
  const gaps = beats.slice(1).map((b, i) => b - beats[i]);
  return {
    id: $("mId").value.trim() || slug($("mTitle").value) || "track",
    title: $("mTitle").value.trim() || "Без названия",
    artist: $("mArtist").value.trim(),
    duration: +ed.duration.toFixed(3),
    bpm: gaps.length ? Math.round(60 / median(gaps)) : 0,
    beats, downbeats,
    countStart: downbeats[0] ?? beats[0],
    sections: ed.sections.map(s => ({ start: +s.start.toFixed(3), type: s.type })),
    accents: ed.accents.map(a => ({ time: +a.time.toFixed(3), type: a.type, ...(a.duration && { duration: +a.duration.toFixed(3) }) })),
    danceStart: +(ed.danceStart ?? downbeats[0] ?? beats[0] ?? 0).toFixed(3),
    verified: $("verified").checked,
    license: $("mLicense").value.trim(),
    source: $("mSource").value.trim(),
  };
}

const TRANSLIT = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k",
  л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh",
  щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };
const slug = (s) => s.toLowerCase().trim()
  .replace(/[а-яё]/g, c => TRANSLIT[c] ?? "")
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")        // á → a
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function touched() { ed.dirty = true; draw(); restartIfPlaying(); }

/* ─── волна ─── */

function computePeaks(buf) {
  const ch = buf.getChannelData(0), per = Math.floor(buf.sampleRate / ed.PPS), n = Math.floor(ch.length / per);
  const p = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    let lo = 0, hi = 0;
    for (let k = i * per, e = k + per; k < e; k++) { const v = ch[k]; if (v < lo) lo = v; if (v > hi) hi = v; }
    p[2 * i] = lo; p[2 * i + 1] = hi;
  }
  return p;
}

function fitCanvas(cv) {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [g, w, h];
}

const tx = (t, w) => ((t - ed.view.start) / ed.view.dur) * w;
const xt = (x, w) => ed.view.start + (x / w) * ed.view.dur;

function drawWaveform(g, w, h, from, dur, top, height) {
  if (!ed.peaks) return;
  const mid = top + height / 2, n = ed.peaks.length / 2;
  g.fillStyle = "rgba(240,237,232,.55)";
  for (let x = 0; x < w; x++) {
    const a = Math.floor((from + (x / w) * dur) * ed.PPS), b = Math.max(a + 1, Math.floor((from + ((x + 1) / w) * dur) * ed.PPS));
    let lo = 0, hi = 0;
    for (let i = Math.max(0, a); i < Math.min(n, b); i++) { if (ed.peaks[2 * i] < lo) lo = ed.peaks[2 * i]; if (ed.peaks[2 * i + 1] > hi) hi = ed.peaks[2 * i + 1]; }
    g.fillRect(x, mid - hi * height / 2, 1, Math.max(1, (hi - lo) * height / 2));
  }
}

function sectionSpans() {
  return ed.sections.map((s, k) => ({ ...s, end: ed.sections[k + 1]?.start ?? ed.duration }));
}

function draw() {
  const [g, w, h] = fitCanvas(wave);
  g.clearRect(0, 0, w, h);
  if (!ed.buffer) { g.fillStyle = "#8A9296"; g.font = "14px system-ui"; g.fillText("Здесь будет волна трека", 16, h / 2); drawOverview(); return; }
  const top = 28, height = h - top - 22;

  // части — цветным фоном
  for (const s of sectionSpans()) {
    const x0 = tx(s.start, w), x1 = tx(s.end, w);
    if (x1 < 0 || x0 > w) continue;
    g.fillStyle = SEC_COLORS[s.type]; g.globalAlpha = 0.12; g.fillRect(x0, 0, x1 - x0, h);
    g.globalAlpha = 1; g.fillRect(x0, 0, x1 - x0, 3);
    g.font = "11px system-ui"; g.fillText(s.type, Math.max(x0, 0) + 4, 15);
  }
  drawWaveform(g, w, h, ed.view.start, ed.view.dur, top, height);

  // удары: тонкие риски, «раз» — толще и с цифрой, выбранный — жёлтый
  const counts = ed.beats.length ? beatCounts({ beats: ed.beats, downbeats: downIdx().map(i => ed.beats[i]) }) : [];
  const dense = ed.view.dur / w * 1000 > 15;   // много ударов на пиксель — без подписей
  ed.beats.forEach((b, i) => {
    const x = tx(b, w);
    if (x < -2 || x > w + 2) return;
    const one = counts[i] === 1, sel = i === ed.sel;
    g.fillStyle = sel ? "#E8B23A" : one ? "#79B3A5" : "rgba(240,237,232,.5)";
    g.fillRect(Math.round(x) - (one || sel ? 1 : 0), top - 4, one || sel ? 3 : 1, height + 8);
    if (!dense || one) { g.font = one ? "600 12px system-ui" : "10px system-ui"; g.fillText(counts[i] ?? "", x + 3, h - 6); }
  });

  // акценты
  for (const a of ed.accents) {
    const x = tx(a.time, w);
    if (a.type === "break") { g.fillStyle = "#E0654F"; g.fillRect(x, 18, Math.max(4, tx(a.time + (a.duration || 0.5), w) - x), 6); }
    else { g.fillStyle = "#F0EDE8"; g.beginPath(); g.moveTo(x, 16); g.lineTo(x + 5, 22); g.lineTo(x, 28); g.lineTo(x - 5, 22); g.fill(); }
  }
  // начало танца
  if (ed.danceStart != null) {
    const x = tx(ed.danceStart, w);
    g.fillStyle = "#79B3A5"; g.fillRect(x, 16, 2, h - 16);
    g.beginPath(); g.moveTo(x + 2, 16); g.lineTo(x + 12, 20); g.lineTo(x + 2, 24); g.fill();
  }
  // курсор и воспроизведение
  g.fillStyle = "#F0EDE8"; g.fillRect(Math.round(tx(ed.cursor, w)), 0, 1, h);
  if (playMode) { g.fillStyle = "#E8B23A"; g.fillRect(Math.round(tx(playPos(), w)), 0, 2, h); }
  // тапы
  g.fillStyle = "#E8B23A";
  for (const t of ed.taps) { const x = tx(t, w); if (x >= 0 && x <= w) g.fillRect(x - 1, h - 20, 3, 8); }

  drawOverview();
  $("timeCur").textContent = `${clock(ed.cursor)} · вид ${clock(ed.view.start)}–${clock(ed.view.start + ed.view.dur)}`;
}

function drawOverview() {
  const [g, w, h] = fitCanvas(over);
  g.clearRect(0, 0, w, h);
  if (!ed.buffer) return;
  for (const s of sectionSpans()) { g.fillStyle = SEC_COLORS[s.type]; g.globalAlpha = 0.25; g.fillRect(s.start / ed.duration * w, 0, (s.end - s.start) / ed.duration * w, h); }
  g.globalAlpha = 1;
  drawWaveform(g, w, h, 0, ed.duration, 2, h - 4);
  g.strokeStyle = "#E8B23A"; g.lineWidth = 2;
  g.strokeRect(ed.view.start / ed.duration * w, 1, Math.max(3, ed.view.dur / ed.duration * w), h - 2);
  if (playMode) { g.fillStyle = "#E8B23A"; g.fillRect(playPos() / ed.duration * w, 0, 1, h); }
}

const clock = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, "0")}`;

function setView(start, dur) {
  dur = Math.max(1, Math.min(ed.duration || 20, dur));
  ed.view = { start: Math.max(0, Math.min((ed.duration || 20) - dur, start)), dur };
  draw();
}

/* ─── мышь и касания по волне ─── */
let drag = null;
wave.addEventListener("pointerdown", (e) => {
  if (!ed.buffer) return;
  const r = wave.getBoundingClientRect(), x = e.clientX - r.left, w = r.width;
  const t = xt(x, w);
  // Клик всегда ставит курсор. Рядом с риской (±7 px) — ещё и выбирает удар (его можно
  // тащить), но только когда риски не слишком густо: иначе промахнуться мимо удара нельзя.
  const spacing = (ed.beats.length > 1 ? (ed.duration / ed.beats.length) : 1) / ed.view.dur * w;
  let near = -1, best = 8;
  if (spacing >= 16) ed.beats.forEach((b, i) => { const d = Math.abs(tx(b, w) - x); if (d < best) { best = d; near = i; } });
  if (near >= 0) {
    ed.sel = near;
    ed.cursor = ed.beats[near];
    drag = { i: near, x0: x, b0: ed.beats[near], tail: ed.beats.slice(near) };
    wave.setPointerCapture(e.pointerId);
  } else {
    ed.sel = null;
    ed.cursor = Math.max(0, Math.min(ed.duration, t));
    if (playMode) startPlay(playMode);
  }
  updateSel(); draw();
});
wave.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const r = wave.getBoundingClientRect(), dt = ((e.clientX - r.left - drag.x0) / r.width) * ed.view.dur;
  if ($("pullTail").checked) drag.tail.forEach((b, k) => { ed.beats[drag.i + k] = b + dt; });
  else ed.beats[drag.i] = clampBeat(drag.i, drag.b0 + dt);
  draw();
});
wave.addEventListener("pointerup", () => { if (drag && ed.beats[drag.i] !== drag.b0) touched(); drag = null; updateSel(); });
wave.addEventListener("wheel", (e) => {
  if (!ed.buffer) return;
  e.preventDefault();
  const r = wave.getBoundingClientRect(), t = xt(e.clientX - r.left, r.width);
  if (e.ctrlKey || e.metaKey) {
    const k = Math.exp(e.deltaY * 0.01), dur = Math.max(1, Math.min(ed.duration, ed.view.dur * k));
    setView(t - ((t - ed.view.start) / ed.view.dur) * dur, dur);
  } else {
    setView(ed.view.start + ((e.deltaX || e.deltaY) / r.width) * ed.view.dur, ed.view.dur);
  }
}, { passive: false });

function overviewJump(e) {
  if (!ed.buffer) return;
  const r = over.getBoundingClientRect(), t = ((e.clientX - r.left) / r.width) * ed.duration;
  setView(t - ed.view.dur / 2, ed.view.dur);
}
over.addEventListener("pointerdown", (e) => { overviewJump(e); over.setPointerCapture(e.pointerId); over.onpointermove = overviewJump; });
over.addEventListener("pointerup", () => { over.onpointermove = null; });

$("zoomIn").onclick = () => setView(ed.cursor - ed.view.dur / 4, ed.view.dur / 2);
$("zoomOut").onclick = () => setView(ed.cursor - ed.view.dur, ed.view.dur * 2);
$("zoomAll").onclick = () => setView(0, ed.duration);

function clampBeat(i, t) {
  const lo = (ed.beats[i - 1] ?? -1) + 0.05, hi = (ed.beats[i + 1] ?? ed.duration + 1) - 0.05;
  return Math.max(lo, Math.min(hi, t));
}

/* ─── загрузка ─── */
$("audioFile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  status("Читаю аудио…");
  try {
    ed.buffer = await audio().decodeAudioData(await f.arrayBuffer());
  } catch (err) { status(`<span class="warn">Не получилось прочитать аудио: ${esc(err.message || err)}</span>`); return; }
  ed.audioName = f.name; ed.duration = ed.buffer.duration;
  ed.peaks = computePeaks(ed.buffer);
  if (!$("mTitle").value) $("mTitle").value = f.name.replace(/\.[^.]+$/, "");
  enable();
  setView(0, Math.min(20, ed.duration));
  if (pendingMarkup) applyMarkup(pendingMarkup);
  else await autoMark();
});

let pendingMarkup = null;
$("markupFile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  let raw;
  try { raw = JSON.parse(await f.text()); } catch (err) { status(`<span class="warn">Файл разметки не читается как JSON</span>`); return; }
  if (!ed.buffer) { pendingMarkup = raw; status("Разметка загружена — теперь выбери аудио этого трека."); return; }
  applyMarkup(raw);
});

function applyMarkup(raw) {
  pendingMarkup = null;
  ed.beats = (raw.beats || []).filter(Number.isFinite).sort((a, b) => a - b);
  // «раз» из файла → номера ударов; назначенными считаем те, где шаг от прошлого «раз» не 8
  const idx = (raw.downbeats || []).map(t => nearestBeat(t)).filter(i => i >= 0);
  ed.anchors = idx.filter((i, k) => k === 0 || i - idx[k - 1] !== 8);
  ed.sections = (raw.sections || []).filter(s => SECTION_TYPES.includes(s.type)).sort((a, b) => a.start - b.start);
  ed.accents = (raw.accents || []).map(a => ({ ...a }));
  ed.danceStart = Number.isFinite(raw.danceStart) ? raw.danceStart : null;
  $("mId").value = raw.id || ""; $("mTitle").value = raw.title || $("mTitle").value; $("mArtist").value = raw.artist || "";
  $("mLicense").value = raw.license || ""; $("mSource").value = raw.source || "";
  $("verified").checked = raw.verified === true;
  const warn = Number.isFinite(raw.duration) && Math.abs(raw.duration - ed.duration) > 1
    ? ` <span class="warn">Похоже, это другая версия трека: в разметке ${fmt(raw.duration)}, аудио ${fmt(ed.duration)}.</span>` : "";
  status(`Разметка загружена: ${ed.beats.length} ударов, ${downIdx().length} «раз».` + warn);
  ed.dirty = false;
  renderItems(); updateSel(); draw();
}

async function autoMark() {
  status("Размечаю автоматически…");
  await new Promise(r => setTimeout(r, 30));   // дать экрану обновиться
  const ch = ed.buffer.numberOfChannels > 1
    ? ed.buffer.getChannelData(0).map((v, i) => (v + ed.buffer.getChannelData(1)[i]) / 2)
    : ed.buffer.getChannelData(0);
  const t0 = performance.now();
  const r = detectBeats(ch, ed.buffer.sampleRate);
  ed.beats = r.beats;
  ed.anchors = r.beats.length > r.onePhase ? [r.onePhase] : [];
  ed.sel = null; ed.dirty = true;
  const sure = r.confidence > 4 ? "" : ` <span class="warn">Уверенность низкая (${r.confidence}) — проверь сетку на слух.</span>`;
  status(`Нашёл ${r.beats.length} ударов, ~${r.bpm} BPM, за ${((performance.now() - t0) / 1000).toFixed(1)} с. «Раз» — догадка по басу: проверь на слух и поправь кнопкой «Здесь раз».` + sure);
  renderItems(); updateSel(); draw();
}
$("autoBtn").onclick = () => { if (!ed.dirty || confirm("Заменить текущую сетку автоматической?")) autoMark(); };

function enable() {
  for (const id of ["autoBtn", "playBtn", "checkBtn", "addBeat", "tapMode", "breakBtn", "hitBtn", "danceBtn", "saveBtn", "catalogBtn"]) $(id).disabled = false;
  document.querySelectorAll("#secBtns button").forEach(b => (b.disabled = false));
}

const nearestBeat = (t) => {
  if (!ed.beats.length) return -1;
  const i = beatIndexAt(ed.beats, t);
  if (i < 0) return 0;
  return i + 1 < ed.beats.length && ed.beats[i + 1] - t < t - ed.beats[i] ? i + 1 : i;
};

/* ─── правка сетки ─── */
document.querySelectorAll("[data-shift]").forEach(b => b.onclick = () => {
  const d = +b.dataset.shift / 1000;
  ed.beats = ed.beats.map(x => x + d);
  touched();
});
document.querySelectorAll("[data-move]").forEach(b => b.onclick = () => moveSel(+b.dataset.move / 1000));

function moveSel(d) {
  if (ed.sel == null) return;
  if ($("pullTail").checked) for (let i = ed.sel; i < ed.beats.length; i++) ed.beats[i] += d;
  else ed.beats[ed.sel] = clampBeat(ed.sel, ed.beats[ed.sel] + d);
  updateSel(); touched();
}

$("oneBtn").onclick = () => hereOne();
function hereOne() {
  if (ed.sel == null) return;
  // назначенный «раз» заменяет соседние назначения ближе восьмёрки
  ed.anchors = ed.anchors.filter(a => Math.abs(a - ed.sel) >= 8).concat(ed.sel);
  touched(); updateSel();
}

$("delBeat").onclick = () => {
  if (ed.sel == null) return;
  const i = ed.sel;
  ed.beats.splice(i, 1);
  ed.anchors = ed.anchors.filter(a => a !== i).map(a => (a > i ? a - 1 : a));
  ed.sel = null; updateSel(); touched();
};
$("addBeat").onclick = () => {
  const t = ed.cursor, i = beatIndexAt(ed.beats, t) + 1;
  ed.beats.splice(i, 0, t);
  ed.anchors = ed.anchors.map(a => (a >= i ? a + 1 : a));
  ed.sel = i; updateSel(); touched();
};

function updateSel() {
  const has = ed.sel != null && ed.beats[ed.sel] != null;
  document.querySelectorAll(".needsel").forEach(b => (b.disabled = !has));
  if (!has) { $("selInfo").textContent = "не выбран"; return; }
  const counts = beatCounts({ beats: ed.beats, downbeats: downIdx().map(i => ed.beats[i]) });
  $("selInfo").textContent = `№${ed.sel + 1} · ${clock(ed.beats[ed.sel])} · счёт ${counts[ed.sel]}`;
}

/* ─── тапы ─── */
$("tapMode").onclick = () => {
  ed.tapping = !ed.tapping;
  document.body.classList.toggle("tapping", ed.tapping);
  $("tapMode").classList.toggle("on", ed.tapping);
  $("tapMode").textContent = ed.tapping ? "Тапаю…" : "Тапать";
  if (ed.tapping) { ed.taps = []; if (!playMode) startPlay("play"); }
  tapInfo();
};
$("tapBig").addEventListener("pointerdown", (e) => { e.preventDefault(); tap(); });
function tap() {
  if (!ed.tapping || !playMode) return;
  ed.taps.push(playPos());
  tapInfo(); draw();
}
function tapInfo() {
  $("tapInfo").textContent = ed.taps.length ? `тапов: ${ed.taps.length}` : "";
  $("tapDone").disabled = ed.taps.length < 8;
}

/* Сетка по тапам: номера тапов по медианному интервалу → прямая «номер → время»
 * методом наименьших квадратов → ровная сетка на весь трек.
 */
$("tapDone").onclick = () => {
  const t = [...ed.taps].sort((a, b) => a - b);
  const p0 = median(t.slice(1).map((x, i) => x - t[i]));
  const n = t.map(x => Math.round((x - t[0]) / p0));
  const mn = n.reduce((s, v) => s + v, 0) / n.length, mt = t.reduce((s, v) => s + v, 0) / t.length;
  let num = 0, den = 0;
  n.forEach((v, i) => { num += (v - mn) * (t[i] - mt); den += (v - mn) ** 2; });
  const period = num / den, phase = mt - period * mn;
  const beats = [];
  for (let k = Math.ceil(-phase / period); phase + k * period <= ed.duration; k++) beats.push(phase + k * period);
  // «раз» — ближайший удар к прежнему первому «раз», если был
  const oldOne = downIdx().length ? ed.beats[downIdx()[0]] : null;
  ed.beats = beats;
  ed.anchors = [oldOne != null ? nearestBeat(oldOne) : 0];
  ed.taps = [];
  if (ed.tapping) $("tapMode").click();
  status(`Сетка по тапам: ${Math.round(60 / period)} BPM (${beats.length} ударов). Сдвинь её целиком, если тапы были чуть раньше или позже.`);
  touched();
};

/* ─── части и акценты ─── */
for (const type of SECTION_TYPES) {
  const b = document.createElement("button");
  b.innerHTML = `<span class="sw" style="background:${SEC_COLORS[type]}"></span>${type}`;
  b.disabled = true;
  b.onclick = () => {
    const t = snap(ed.cursor);
    ed.sections = ed.sections.filter(s => Math.abs(s.start - t) > 0.05).concat({ start: t, type }).sort((a, b) => a.start - b.start);
    renderItems(); touched();
  };
  $("secBtns").appendChild(b);
}
$("breakBtn").onclick = () => {
  const i = nearestBeat(ed.cursor), k = Math.max(1, +$("breakBeats").value || 2);
  const end = ed.beats[i + k] ?? ed.beats[i] + k * 60 / (markup().bpm || 120);
  ed.accents.push({ time: ed.beats[i], type: "break", duration: end - ed.beats[i] });
  ed.accents.sort((a, b) => a.time - b.time); renderItems(); touched();
};
$("hitBtn").onclick = () => { ed.accents.push({ time: snap(ed.cursor), type: "hit" }); ed.accents.sort((a, b) => a.time - b.time); renderItems(); touched(); };
$("danceBtn").onclick = () => { ed.danceStart = snap(ed.cursor); renderItems(); touched(); };

const snap = (t) => (ed.beats.length ? ed.beats[nearestBeat(t)] : t);

function renderItems() {
  const items = [
    ...ed.sections.map((s, k) => ({ t: s.start, text: `<span class="sw" style="background:${SEC_COLORS[s.type]}"></span>${s.type}`, del: () => ed.sections.splice(k, 1) })),
    ...ed.accents.map((a, k) => ({ t: a.time, text: a.type === "break" ? `брейк ${a.duration?.toFixed(2)} с` : "хит", del: () => ed.accents.splice(k, 1) })),
    ...(ed.danceStart != null ? [{ t: ed.danceStart, text: "начало танца", del: () => (ed.danceStart = null) }] : []),
  ].sort((a, b) => a.t - b.t);
  const ul = $("items"); ul.innerHTML = "";
  for (const it of items) {
    const li = document.createElement("li");
    li.innerHTML = `<span>${clock(it.t)} · ${it.text}</span>`;
    const go = document.createElement("button"); go.textContent = "→"; go.title = "Показать";
    go.onclick = () => { ed.cursor = it.t; setView(it.t - ed.view.dur / 3, ed.view.dur); };
    const x = document.createElement("button"); x.textContent = "×"; x.title = "Удалить";
    x.onclick = () => { it.del(); renderItems(); touched(); };
    li.append(go, x); ul.appendChild(li);
  }
}

/* ─── воспроизведение ─── */
function playerMarkup() {
  const m = markup();
  return { ...m, beats: m.beats.length ? m.beats : [0, 1], downbeats: m.downbeats.length ? m.downbeats : [m.beats[0] ?? 0] };
}

function startPlay(mode) {
  player = player || new BeatPlayer(audio(), masterOut());
  playMode = mode;
  const clicks = mode === "check" || $("clicks").checked ? "overlay" : "countin";
  player.start(playerMarkup(), { from: ed.cursor, countInEnd: 0, buffer: ed.buffer, clicks, until: ed.duration });
  $("playBtn").textContent = "❚❚ Пауза";
  $("checkBtn").classList.toggle("on", mode === "check");
  $("bigCount").classList.toggle("on", mode === "check");
  requestAnimationFrame(tick);
}
function stopPlay(keepPos = true) {
  if (!playMode) return;
  if (keepPos) ed.cursor = Math.min(ed.duration, playPos());
  player?.stop();
  playMode = null;
  $("playBtn").textContent = "▶ Играть";
  $("checkBtn").classList.remove("on");
  $("bigCount").classList.remove("on");
  draw();
}
let restartTimer = 0;
function restartIfPlaying() {
  if (!playMode) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => { const m = playMode; ed.cursor = playPos(); startPlay(m); }, 150);
}
const playPos = () => (player ? perfToAudio(performance.now()) - player.origin : ed.cursor);

function tick() {
  if (!playMode) return;
  if (!player.playing) { stopPlay(false); return; }
  requestAnimationFrame(tick);
  const t = playPos();
  // держим позицию воспроизведения в кадре
  if (t > ed.view.start + ed.view.dur * 0.9 || t < ed.view.start) setView(t - ed.view.dur * 0.1, ed.view.dur);
  else draw();
  if (playMode === "check") {
    const b = player.now();
    if (b) { $("bigCount").textContent = b.count; $("bigCount").classList.toggle("one", b.count === 1); }
  }
}

$("playBtn").onclick = () => (playMode ? stopPlay() : startPlay("play"));
$("checkBtn").onclick = () => (playMode === "check" ? stopPlay() : startPlay("check"));
$("clicks").onchange = () => restartIfPlaying();

/* ─── клавиатура ─── */
// Кнопка после клика не держит фокус — иначе пробел «нажимал» бы её ещё раз
// (например, выключал бы режим тапов на первом же тапе).
document.addEventListener("click", (e) => { const b = e.target.closest?.("button"); if (b) b.blur(); });

document.addEventListener("keydown", (e) => {
  if (e.target.matches?.("input[type=text], input[type=number], textarea, select")) return;
  if (!ed.buffer) return;
  if (e.code === "Space") {
    e.preventDefault();
    if (ed.tapping && playMode) tap();
    else playMode ? stopPlay() : startPlay("play");
  } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    if (ed.sel == null) return;
    e.preventDefault();
    moveSel((e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 0.05 : 0.005));
  } else if (e.key === "1") hereOne();
  else if (e.key === "Delete" || e.key === "Backspace") $("delBeat").click();
});

/* ─── сохранение ─── */
$("saveBtn").onclick = () => {
  const m = markup();
  const blob = new Blob([JSON.stringify(m, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `${m.id}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  ed.dirty = false;
  status(`Сохранено: ${m.id}.json — ${m.beats.length} ударов, ${m.downbeats.length} «раз», ${m.sections.length} частей` + (m.verified ? ", проверено ✓" : ", не проверено"));
};

// Запись для каталога: коммерческие треки — без аудио (пользователь выберет свой файл).
$("catalogBtn").onclick = async () => {
  const m = markup(), free = /^(cc|public|pd|cc0)/i.test(m.license);
  const entry = {
    id: m.id, title: m.title, artist: m.artist, bpm: m.bpm, difficulty: +$("mDiff").value,
    duration: m.duration, audio: free ? `tracks/${m.id}.mp3` : null, markup: `tracks/${m.id}.json`,
    license: m.license, source: m.source, verified: m.verified,
  };
  const text = JSON.stringify(entry, null, 2);
  const out = $("catalogOut"); out.style.display = "block"; out.value = text;
  try { await navigator.clipboard.writeText(text); status("Запись для catalog.json скопирована" + (free ? "" : " — без аудио: лицензия не свободная, в каталоге будет «нужен свой файл»")); }
  catch (e) { out.select(); status("Скопируй запись из поля ниже"); }
};

window.addEventListener("beforeunload", (e) => { if (ed.dirty) { e.preventDefault(); e.returnValue = ""; } });
window.addEventListener("resize", draw);

function status(html) { statusEl.innerHTML = html; }
const esc = (x) => String(x).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// для проверки без своего mp3: ?test — тестовый трек со своей же сеткой, но разметка — автоматическая
if (new URLSearchParams(location.search).has("test")) {
  import("./testtrack.js").then(async ({ makeTestTrack }) => {
    const { buffer } = await makeTestTrack(audio().sampleRate);
    ed.buffer = buffer; ed.audioName = "тестовый трек"; ed.duration = buffer.duration;
    ed.peaks = computePeaks(buffer); $("mTitle").value = "Тестовый трек";
    enable(); setView(0, 20); await autoMark();
  });
}

draw(); updateSel();
