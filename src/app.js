/* Оркестровка экранов: старт → проверка кадра → метроном. */

import { PoseEngine } from "./pose.js";
import { checkFullBody, missingPoints, HoldTimer } from "./framing.js";
import { UI, COLORS } from "./ui.js";
import { audio, masterOut, outputLatency } from "./audio.js";
import { metronomeMarkup } from "./beatmap.js";
import { BeatPlayer } from "./player.js";

const DEBUG = new URLSearchParams(location.search).has("debug");
if (DEBUG) document.body.classList.add("debug");

const ui = new UI();
const engine = new PoseEngine(ui.video);
const hold = new HoldTimer();

let facing = "user";
let running = false;
let confirmed = false;   // тело простояло в кадре 2 секунды
let wakeLock = null;
let cameraOn = false;

const nextBtn = document.getElementById("nextBtn");

/* ─── счётчики FPS ───
 * Камера — сколько новых кадров приходит; модель — сколько кадров успели обработать.
 */
const fps = { cam: 0, model: 0, since: performance.now() };
function countCameraFrames() {
  if (!("requestVideoFrameCallback" in HTMLVideoElement.prototype)) return;
  const tick = () => { fps.cam++; ui.video.requestVideoFrameCallback(tick); };
  ui.video.requestVideoFrameCallback(tick);
}
function reportFps(now) {
  const dt = now - fps.since;
  if (dt < 1000) return;
  const cam = fps.cam ? Math.round(fps.cam * 1000 / dt) : "—";
  ui.fps(`камера ${cam} · модель ${Math.round(fps.model * 1000 / dt)} fps · ${engine.delegate}`);
  fps.cam = fps.model = 0; fps.since = now;
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

/* ─── цикл ─── */
function loop() {
  requestAnimationFrame(loop);
  if (!running) return;

  const now = performance.now();
  reportFps(now);

  const res = engine.detect();
  if (res === undefined) return;            // кадр не обновился
  fps.model++;

  ui.resize(ui.video.videoWidth, ui.video.videoHeight);
  ui.clear();
  runFraming(res, now);
}

/* ─── управление ─── */
document.getElementById("startBtn").addEventListener("click", async (e) => {
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
    running = true;
    cameraOn = true;
    countCameraFrames();
    loop();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Включить камеру";
    document.getElementById("startError").textContent =
      "Камера не открылась: " + err.message + ". Нужен https и разрешение на камеру.";
  }
});

document.getElementById("flipBtn").addEventListener("click", async () => {
  facing = facing === "user" ? "environment" : "user";
  await engine.startCamera(facing);
  ui.setMirrored(facing === "user");
  countCameraFrames();
});

nextBtn.addEventListener("click", () => {
  running = false;
  showMetronome();
});

document.getElementById("metroOnlyBtn").addEventListener("click", () => {
  audio();
  showMetronome();
});

/* ─── метроном ─── */
const bpmEl = document.getElementById("bpm");
const bpmVal = document.getElementById("bpmVal");
const playBtn = document.getElementById("playBtn");
const countEl = document.getElementById("count");
const countLabel = document.getElementById("countLabel");
const dots = [...document.querySelectorAll("#dots i")];
const latencyEl = document.getElementById("latency");
let player = null;
let shownIndex = -1;

try { bpmEl.value = localStorage.getItem("bachata.bpm") || bpmEl.value; } catch (e) {}
bpmVal.textContent = bpmEl.value;
bpmEl.addEventListener("input", () => {
  bpmVal.textContent = bpmEl.value;
  try { localStorage.setItem("bachata.bpm", bpmEl.value); } catch (e) {}
});

function showMetronome() {
  ui.show("metro");
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

playBtn.addEventListener("click", async () => {
  const ctx = audio();
  player = player || new BeatPlayer(ctx, masterOut());
  if (player.playing) { player.stop(); setPlaying(false); resetCount(); return; }
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch (err) {}
  resetCount();
  player.start(metronomeMarkup({ bpm: +bpmEl.value }));
  setPlaying(true);
});

// Счёт на экране берётся из тех же аудио-часов, по которым стоят удары,
// с поправкой на задержку вывода звука — поэтому цифра меняется вместе со звуком.
function drawBeat() {
  if (document.body.dataset.screen !== "metro") return;
  requestAnimationFrame(drawBeat);

  if (DEBUG && player) {
    const c = player.ctx;
    latencyEl.textContent = `вывод звука ${Math.round(outputLatency(c) * 1000)} мс · ${c.sampleRate} Гц · ${c.state}`;
  }
  if (!player?.playing) { if (player && shownIndex >= 0) { setPlaying(false); resetCount(); } return; }

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

document.getElementById("backBtn").addEventListener("click", () => {
  player?.stop();
  setPlaying(false);
  if (!cameraOn) { ui.show("start"); return; }
  confirmed = false;
  nextBtn.disabled = true;
  hold.reset();
  ui.show("camera");
  running = true;
});

// Экран гаснет — wake lock снимается; возвращаем его, когда вкладка снова видна.
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && running && (!wakeLock || wakeLock.released)) {
    try { wakeLock = await navigator.wakeLock.request("screen"); } catch (err) {}
  }
});

ui.setMirrored(true);
ui.show("start");
