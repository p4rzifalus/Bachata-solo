/* Оркестровка экранов: старт → проверка кадра → метроном с детекцией шагов. */

import { PoseEngine } from "./pose.js";
import { checkFullBody, missingPoints, HoldTimer } from "./framing.js";
import { UI, COLORS } from "./ui.js";
import { audio, masterOut, outputLatency, perfToAudio } from "./audio.js";
import { metronomeMarkup } from "./beatmap.js";
import { BeatPlayer } from "./player.js";
import { StepDetector } from "./steps.js";
import { loadSettings, mountSliders } from "./debug.js";
import { LiveChart } from "./chart.js";
import { StartCheck, dirWord } from "./start.js";
import { CALIB, computeCalibration } from "./calibrate.js";

const DEBUG = new URLSearchParams(location.search).has("debug");
if (DEBUG) document.body.classList.add("debug");

const ui = new UI();
const engine = new PoseEngine(ui.video);
const hold = new HoldTimer();
const settings = loadSettings();
const detector = new StepDetector(settings);
const chart = new LiveChart(document.getElementById("chart"));

let facing = "user";
let confirmed = false;   // тело простояло в кадре 2 секунды
let wakeLock = null;
let cameraOn = false;
let player = null;
let rec = null;          // запись текущей (или последней) сессии для «Скачать данные»

const $ = (id) => document.getElementById(id);
const nextBtn = $("nextBtn");
const screen = () => document.body.dataset.screen;

// Личная поправка из калибровки: на сколько мс сдвинуть события назад.
const CAL_KEY = "bachata.calibrationMs";
function calibrationMs() {
  try { return +(localStorage.getItem(CAL_KEY) || 0); } catch (e) { return 0; }
}
function hasCalibration() {
  try { return localStorage.getItem(CAL_KEY) != null; } catch (e) { return false; }
}

/* ─── счётчики FPS ───
 * Камера — сколько новых кадров приходит; модель — сколько кадров успели обработать.
 */
const fps = { model: 0, since: performance.now(), text: "—", source: "—" };
function reportFps(now) {
  const dt = now - fps.since;
  if (dt < 1000) return;
  const cam = engine.camFrames ? Math.round(engine.camFrames * 1000 / dt) : "—";
  fps.text = `камера ${cam} · модель ${Math.round(fps.model * 1000 / dt)} fps · ${engine.delegate}`;
  ui.fps(fps.text);
  engine.camFrames = 0; fps.model = 0; fps.since = now;
}

/* ─── проверка кадра ─── */
function runFraming(res, now) {
  const lm = res?.landmarks ?? null;
  const check = checkFullBody(lm);
  const p = hold.update(check.ok, now);

  if (lm) ui.drawSkeleton(lm, check.ok ? COLORS.teal : COLORS.chalk, missingPoints(lm));
  ui.hold(confirmed ? 0 : p);

  if (!confirmed && p >= 1) {
    confirmed = true;
    nextBtn.disabled = false;
    ui.beep(760, 90);
  }

  if (confirmed) {
    // Кнопку не выключаем, когда человек выходит из кадра: к телефону всё равно придётся подойти.
    ui.hint(check.ok ? "Отлично, всё тело в кадре. Жми <b>«Дальше»</b>." : check.msg, check.ok ? "good" : "warn");
  } else {
    ui.hint(check.msg, check.ok ? "good" : "warn");
  }
}

/* ─── танец: детекция шагов поверх метронома ─── */
const flashEl = $("flash"), tapIcon = $("tapIcon"), dbgLive = $("dbgLive");
let tapTimer = 0;

function flash(color) {
  flashEl.style.setProperty("--flash", color);
  flashEl.classList.remove("on");
  void flashEl.offsetWidth;
  flashEl.classList.add("on");
}

function recordFrame(lm, tAudio) {
  if (!rec?._markup) return;
  rec.frames.push({
    t: +tAudio.toFixed(4),
    lm: lm ? lm.map(p => [+p.x.toFixed(4), +p.y.toFixed(4), +(p.visibility ?? 0).toFixed(2)]) : null,
  });
}

function timingColor(offsetMs) {
  const a = Math.abs(offsetMs);
  return a <= 70 ? COLORS.teal : a <= 150 ? COLORS.amber : COLORS.red;
}

function runDance(res, tAudio) {
  const lm = res?.landmarks ?? null;
  if (lm) ui.drawSkeleton(lm, "rgba(240,237,232,.55)");

  const playing = player?.playing;
  if (playing) detector.setBeatPeriod(60 / player.markup.bpm);
  const msgs = detector.update(lm, tAudio, ui.canvas.width, ui.canvas.height);
  const shift = calibrationMs() / 1000;

  if (playing) recordFrame(lm, tAudio);
  if (DEBUG && detector.sample) chart.push(tAudio - shift, detector.sample);

  for (const m of msgs) {
    const t = m.t - shift;
    const match = playing ? player.match(t) : null;
    if (m.kind === "land") {
      // вспышка сразу, как стопа встала; без метронома — белая, просто «вижу шаг»
      flash(match && !match.countIn ? timingColor(match.offsetMs) : COLORS.chalk);
      if (DEBUG) chart.mark(t, m.foot, "land");
      if (match) checkOne(t, m.dir, match, m.pending.conf);
      continue;
    }
    // итог шаг/тап приходит к следующей постановке: тап — если следующей встала та же стопа
    if (m.type === "tap") {
      tapIcon.classList.add("on");
      clearTimeout(tapTimer);
      tapTimer = setTimeout(() => tapIcon.classList.remove("on"), 450);
    }
    if (DEBUG) chart.mark(t, m.foot, m.type);
    const ev = { ...m, t: +m.t.toFixed(4), ...(match && { beat: match.index, count: match.count, offsetMs: Math.round(match.offsetMs) }) };
    if (rec && playing) rec.events.push(ev);
    if (DEBUG) {
      const side = m.foot === "L" ? "левая" : "правая";
      dbgLive.textContent = `${side} · ${m.type === "step" ? "шаг" : "тап"} ${dirWord(m.dir)}` +
        (match ? ` · ${match.offsetMs >= 0 ? "+" : ""}${Math.round(match.offsetMs)} мс · счёт ${match.count}` : "") +
        ` · ${m.how === "touch" ? "касание" : "встала"} · уверенность ${m.conf}\n${fps.text} · время кадра: ${fps.source}`;
    }
  }
}

/* ─── старт с раз и направление (логика — в start.js) ─── */
const startNote = $("startNote"), onesNote = $("onesNote");
let oneDir = "left";
try { oneDir = localStorage.getItem("bachata.oneDir") || "left"; } catch (e) {}
let startCheck = null;

function resetStart() {
  startCheck = null;
  startNote.textContent = ""; startNote.className = "";
  onesNote.textContent = "";
}

function checkOne(t, dir, match, conf) {
  if (!startCheck) startCheck = new StartCheck(oneDir, player.beatTime(player.countInEnd), 60 / player.markup.bpm);
  const decided = startCheck.push({ t, dir, conf, count: match.count, countIn: match.countIn, offsetMs: match.offsetMs });
  if (decided) {
    startNote.textContent = decided.verdict;
    startNote.className = decided.ok ? "good" : "warn";
    if (rec) rec.start = decided;
  }
  onesNote.textContent = startCheck.onesText();
  if (rec && startCheck.ones.n) rec.ones = { ...startCheck.ones, want: dirWord(startCheck.want) };
}

document.querySelectorAll("#oneDir button").forEach(b => {
  b.setAttribute("aria-pressed", String(b.dataset.dir === oneDir));
  b.addEventListener("click", () => {
    oneDir = b.dataset.dir;
    try { localStorage.setItem("bachata.oneDir", oneDir); } catch (e) {}
    document.querySelectorAll("#oneDir button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  });
});

function drawChart() {
  if (!DEBUG || !cameraOn || screen() !== "metro") return;
  // ось — время звука; точки тела и события на графике уже сдвинуты на поправку калибровки
  const now = perfToAudio(performance.now());
  const beats = [];
  if (player?.markup) {
    const b = player.markup.beats;
    for (let i = 0; i < b.length; i++) {
      const t = player.beatTime(i);
      if (t < now - 5) continue;
      if (t > now) break;
      beats.push({ t, count: player.counts[i] });
    }
  }
  chart.draw(now, beats);
}

/* ─── цикл ─── */
function loop() {
  requestAnimationFrame(loop);
  const scr = screen();
  if (!cameraOn || (scr !== "camera" && scr !== "metro" && scr !== "calib")) return;

  const now = performance.now();
  reportFps(now);
  drawChart();

  const res = engine.detect();
  if (res === undefined) return;            // кадр не обновился
  fps.model++;
  if (res) fps.source = res.source;

  ui.resize(ui.video.videoWidth, ui.video.videoHeight);
  ui.clear();
  const tAudio = perfToAudio(res ? res.frameTime : now);
  if (scr === "camera") runFraming(res, now);
  else if (scr === "calib") runCalib(res, tAudio);
  else runDance(res, tAudio);
}

/* ─── управление ─── */
$("startBtn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = "Загружаю модель…";
  audio();                                   // по жесту — иначе iOS не даст звук
  try {
    await engine.startCamera(facing);
    await engine.initModel();
    try { wakeLock = await navigator.wakeLock.request("screen"); } catch (err) {}
    ui.show("camera");
    ui.hint("Встань в паре метров от камеры, чтобы было видно тебя целиком.");
    cameraOn = true;
    document.body.classList.add("cam");
    loop();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Включить камеру";
    $("startError").textContent =
      "Камера не открылась: " + err.message + ". Нужен https и разрешение на камеру.";
  }
});

$("flipBtn").addEventListener("click", async () => {
  facing = facing === "user" ? "environment" : "user";
  await engine.startCamera(facing);
  ui.setMirrored(facing === "user");
});

// Первый раз — сначала калибровка; потом она доступна кнопкой «Перекалибровать».
nextBtn.addEventListener("click", () => (hasCalibration() ? showMetronome() : showCalib()));

$("metroOnlyBtn").addEventListener("click", () => {
  audio();
  showMetronome();
});

/* ─── метроном ─── */
const bpmEl = $("bpm"), bpmVal = $("bpmVal"), playBtn = $("playBtn");
const countEl = $("count"), countLabel = $("countLabel"), latencyEl = $("latency");
const dots = [...document.querySelectorAll("#dots i")];
let shownIndex = -1;

try { bpmEl.value = localStorage.getItem("bachata.bpm") || bpmEl.value; } catch (e) {}
bpmVal.textContent = bpmEl.value;
bpmEl.addEventListener("input", () => {
  bpmVal.textContent = bpmEl.value;
  try { localStorage.setItem("bachata.bpm", bpmEl.value); } catch (e) {}
});

function showMetronome() {
  if (calib.running) stopCalib();
  updateCalVal();
  ui.show("metro");
  detector.reset();
  chart.clear();
  resetCount();
  requestAnimationFrame(drawBeat);
}

function resetCount() {
  shownIndex = -1;
  countEl.textContent = "·";
  countEl.className = "";
  countLabel.innerHTML = "&nbsp;";
  dots.forEach(d => d.classList.remove("on"));
}

function setPlaying(on) {
  playBtn.textContent = on ? "Стоп" : "Старт";
  bpmEl.disabled = on;
}

function stopPlaying() {
  if (player?.playing) player.stop();
  setPlaying(false);
  resetCount();
  finishRecording();
}

playBtn.addEventListener("click", async () => {
  const ctx = audio();
  player = player || new BeatPlayer(ctx, masterOut());
  if (player.playing) { stopPlaying(); return; }
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch (err) {}
  resetCount();
  const markup = metronomeMarkup({ bpm: +bpmEl.value });
  resetStart();
  player.start(markup);
  detector.setBeatPeriod(60 / markup.bpm);
  if (cameraOn) startRecording(markup);
  setPlaying(true);
});

// Счёт на экране берётся из тех же аудио-часов, по которым стоят удары,
// с поправкой на задержку вывода звука — поэтому цифра меняется вместе со звуком.
function drawBeat() {
  if (screen() !== "metro") return;
  requestAnimationFrame(drawBeat);

  if (DEBUG && player) {
    const c = player.ctx;
    latencyEl.textContent = `вывод звука ${Math.round(outputLatency(c) * 1000)} мс · ${c.sampleRate} Гц · ${c.state} · поправка ${calibrationMs()} мс`;
  }
  if (!player?.playing) { if (player && shownIndex >= 0) stopPlaying(); return; }

  const b = player.now();
  if (!b || b.index === shownIndex) return;
  shownIndex = b.index;

  countEl.textContent = b.count;
  countEl.className = b.countIn ? "countin" : b.count === 1 ? "one" : "";
  void countEl.offsetWidth;
  countEl.classList.add("pop");
  countLabel.textContent = b.countIn ? "отсчёт" : "";
  dots.forEach((d, k) => d.classList.toggle("on", !b.countIn && k < b.count));
}

$("backBtn").addEventListener("click", () => {
  stopPlaying();
  if (!cameraOn) { ui.show("start"); return; }
  confirmed = false;
  nextBtn.disabled = true;
  hold.reset();
  ui.show("camera");
});

/* ─── калибровка задержки ───
 * Метроном: отсчёт «5-6-7-8», потом 16 ударов базового шага. Первые 4 не считаются,
 * по остальным — медиана опозданий (src/calibrate.js). Итог — в localStorage.
 */
const calibEl = $("calib"), calibText = $("calibText"), calibCount = $("calibCount");
const calibProgress = $("calibProgress"), calibResult = $("calibResult");
const calibGo = $("calibGo"), calibSkip = $("calibSkip");
const calib = { running: false, finishing: false, lands: [], shown: -1, bpm: 128 };

function calibState(state) {
  calibEl.dataset.state = state;
  const side = oneDir === "left" ? "левой влево" : "правой вправо";
  if (state === "intro") {
    calibText.innerHTML = `Встань так, чтобы было видно всё тело. После отсчёта «5-6-7-8» танцуй
      <b>базовый шаг</b> — 16 ударов, начни на раз <b>${side}</b>.<br>Так я узнаю твою личную задержку:
      наушники, камера и реакция. Надень те наушники, в которых будешь танцевать.`;
    calibProgress.textContent = "";
    calibGo.textContent = "Начать";
    calibSkip.textContent = hasCalibration() ? "Отмена" : "Пропустить";
  } else if (state === "running") {
    calibText.innerHTML = `Базовый шаг на каждый удар, начни на раз <b>${side}</b>.`;
    calibGo.textContent = "Стоп";
    calibSkip.textContent = "Отмена";
  }
}

function showCalib() {
  stopPlaying();
  detector.reset();
  calib.running = false;
  calibState("intro");
  ui.show("calib");
}

function startCalib() {
  const ctx = audio();
  player = player || new BeatPlayer(ctx, masterOut());
  calib.bpm = +bpmEl.value;
  const P = 60 / calib.bpm;
  const markup = metronomeMarkup({ bpm: calib.bpm, countIn: 4, duration: (4 + CALIB.beats) * P + 0.01 });
  calib.lands = []; calib.running = true; calib.finishing = false; calib.shown = -1;
  detector.reset();
  detector.setBeatPeriod(P);
  player.start(markup);
  startRecording(markup);
  rec.kind = "calibration";
  calibState("running");
  calibCount.textContent = "·";
  requestAnimationFrame(drawCalib);
}

function stopCalib() {
  player?.stop();
  calib.running = false;
  finishRecording();
}

function runCalib(res, tAudio) {
  const lm = res?.landmarks ?? null;
  if (lm) ui.drawSkeleton(lm, "rgba(240,237,232,.55)");
  const msgs = detector.update(lm, tAudio, ui.canvas.width, ui.canvas.height);
  if (!calib.running) return;
  recordFrame(lm, tAudio);
  for (const m of msgs) {
    if (m.kind !== "land") continue;
    calib.lands.push({ t: m.t, foot: m.foot, dir: m.dir });   // без поправки: её и меряем
    flash(COLORS.chalk);
  }
}

function drawCalib() {
  if (screen() !== "calib" || !calib.running) return;
  requestAnimationFrame(drawCalib);
  if (!player.playing) {
    // доигрался последний удар — ждём, пока встанет последняя стопа, и считаем
    if (!calib.finishing) { calib.finishing = true; setTimeout(finishCalib, 600); }
    return;
  }
  const b = player.now();
  if (!b || b.index === calib.shown) return;
  calib.shown = b.index;
  calibCount.textContent = b.count;
  calibCount.className = b.countIn ? "countin" : "";
  const k = b.index - player.countInEnd + 1;
  calibProgress.textContent = b.countIn ? "отсчёт" : k <= CALIB.skip ? `входим в ритм · ${k} из ${CALIB.beats}` : `${k} из ${CALIB.beats}`;
}

function finishCalib() {
  if (!calib.running) return;
  calib.running = false;
  const P = 60 / calib.bpm, beats = [], counts = [];
  for (let i = player.countInEnd; i < player.countInEnd + CALIB.beats; i++) {
    beats.push(player.beatTime(i));
    counts.push(player.counts[i]);
  }
  const r = computeCalibration(calib.lands, beats, counts, P, oneDir);
  if (rec) { rec.calibration = r; finishRecording(); }

  calibState("result");
  if (r.ok) {
    try { localStorage.setItem(CAL_KEY, String(r.ms)); } catch (e) {}
    calibResult.textContent = `Твоя поправка: ${r.ms} мс`;
    calibResult.className = "good";
    calibText.innerHTML = "Если сменишь наушники или колонку — перекалибруйся.";
    calibSkip.textContent = "Ещё раз";
    calibGo.textContent = "Дальше";
  } else {
    calibResult.textContent = r.reason;
    calibResult.className = "warn";
    calibText.innerHTML = hasCalibration() ? `Оставлю прежнюю поправку: ${calibrationMs()} мс.` : "";
    calibSkip.textContent = hasCalibration() ? "Дальше" : "Пропустить";
    calibGo.textContent = "Ещё раз";
  }
  calibProgress.textContent = `шагов ${r.hits} из ${r.expected} · разброс ±${r.spread} мс` +
    (DEBUG ? ` · нога совпала ${r.footMatch}${r.lateBeat ? " · опоздание больше полуудара" : ""}` : "");
  updateCalVal();
}

calibGo.addEventListener("click", () => {
  const state = calibEl.dataset.state;
  if (state === "running") { stopCalib(); calibState("intro"); return; }
  if (state === "result" && calibResult.className === "good") { showMetronome(); return; }
  startCalib();
});

calibSkip.addEventListener("click", () => {
  const state = calibEl.dataset.state;
  if (state === "running") { stopCalib(); calibState("intro"); return; }
  if (state === "result" && calibResult.className === "good") { startCalib(); return; }   // «Ещё раз»
  showMetronome();
});

function updateCalVal() {
  $("calVal").textContent = hasCalibration() ? `${calibrationMs()} мс` : "нет";
}
$("recalBtn").addEventListener("click", showCalib);
updateCalVal();

/* ─── запись сессии ───
 * Сырые точки по кадрам + события + удары. Потом детекцию можно прогнать
 * на записи без повторного танца: node tools/replay.mjs запись.json
 */
function startRecording(markup) {
  rec = {
    version: 1,
    recordedAt: new Date().toISOString(),
    bpm: markup.bpm,
    videoW: ui.video.videoWidth,
    videoH: ui.video.videoHeight,
    calibrationMs: calibrationMs(),
    oneDir,
    outputLatencyMs: Math.round(outputLatency(player.ctx) * 1000),
    delegate: engine.delegate,
    userAgent: navigator.userAgent,
    frames: [],
    events: [],
  };
  rec._markup = markup;
  rec._origin = player.origin;
  rec._counts = player.counts;
  rec._countStart = player.countInEnd;
}

// Готовая к выгрузке копия записи: добавляем удары, которые прозвучали за время записи.
function snapshot(r) {
  const m = r._markup, end = r.frames.at(-1)?.t ?? 0;
  const out = { ...r, frames: [...r.frames], events: [...r.events], beats: [], counts: [] };
  delete out._markup;
  for (let i = 0; i < m.beats.length; i++) {
    const t = r._origin + m.beats[i];
    if (t > end + 1) break;
    out.beats.push(+t.toFixed(4));
    out.counts.push(r._counts[i]);
  }
  out.countStartIndex = r._countStart;
  out.frameTimeSource = fps.source;
  out.settings = { ...settings };
  for (const k of ["_origin", "_counts", "_countStart"]) delete out[k];
  return out;
}

function finishRecording() {
  if (rec?._markup) rec = snapshot(rec);
}

$("exportBtn").addEventListener("click", () => {
  if (!rec || !rec.frames.length) { dbgLive.textContent = "Записывать нечего: включи камеру и потанцуй под метроном."; return; }
  const data = rec._markup ? snapshot(rec) : rec;   // можно скачать, не останавливая метроном
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `bachata-session-${data.recordedAt.replace(/[:.]/g, "-").slice(0, 19)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

/* ─── пороги ─── */
const sliders = mountSliders($("sliderRows"), settings);
$("slidersBtn").addEventListener("click", () => $("sliders").classList.add("on"));
$("slidersClose").addEventListener("click", () => $("sliders").classList.remove("on"));
$("slidersReset").addEventListener("click", () => sliders.reset());

// Экран гаснет — wake lock снимается; возвращаем его, когда вкладка снова видна.
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && cameraOn && (!wakeLock || wakeLock.released)) {
    try { wakeLock = await navigator.wakeLock.request("screen"); } catch (err) {}
  }
});

ui.setMirrored(true);
ui.show("start");
