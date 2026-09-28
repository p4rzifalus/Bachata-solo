/* Тестовый трек: синтезированный бачата-ритм с живым темпом, частями и брейком,
 * плюс его точная разметка. Нужен, чтобы проверить воспроизведение по разметке,
 * когда своего размеченного трека ещё нет. Всё считается в браузере.
 */

import { guira, bass, bongo } from "./sounds.js";

const BPM = 124;
// части по восьмёркам: [тип, сколько восьмёрок]
const PLAN = [["intro", 1], ["derecho", 4], ["majao", 4], ["mambo", 4], ["outro", 1]];
const CHORDS = [[220, 261.6, 329.6], [174.6, 220, 261.6], [261.6, 329.6, 392], [196, 246.9, 293.7]]; // Am F C G

function pluck(ctx, out, t, freq, peak = 0.12) {
  const o = ctx.createOscillator(); o.type = "triangle"; o.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
  o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.4);
}

function crash(ctx, out, t) {
  const len = Math.floor(ctx.sampleRate * 0.6), buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.15));
  const s = ctx.createBufferSource(); s.buffer = buf;
  const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 3000;
  const g = ctx.createGain(); g.gain.value = 0.5;
  s.connect(hp); hp.connect(g); g.connect(out); s.start(t);
}

export async function makeTestTrack(sampleRate = 44100) {
  // удары с «живым» темпом: ±1,2% волной с периодом ~25 с
  const lead = 0.6, beats = [];
  let t = lead;
  const total = PLAN.reduce((s, [, n]) => s + n * 8, 0);
  for (let i = 0; i < total; i++) {
    beats.push(+t.toFixed(4));
    t += 60 / (BPM * (1 + 0.012 * Math.sin((2 * Math.PI * t) / 25)));
  }
  // конец — чуть меньше удара после последнего, чтобы сетку не пришлось продолжать
  const duration = +(beats.at(-1) + 0.4).toFixed(3);

  const sections = [], downbeats = [], accents = [];
  let b = 0;
  for (const [type, eights] of PLAN) {
    sections.push({ start: beats[b], type });
    for (let e = 0; e < eights; e++) downbeats.push(beats[b + e * 8]);
    b += eights * 8;
  }
  // брейк: последние 2 удара derecho музыка молчит; хит — на «раз» второй восьмёрки mambo
  const breakFrom = 8 + 4 * 8 - 2, hitAt = 8 + 8 * 8 + 8;
  accents.push({ time: beats[breakFrom], type: "break", duration: +(beats[breakFrom + 2] - beats[breakFrom]).toFixed(3) });
  accents.push({ time: beats[hitAt], type: "hit" });

  const ctx = new OfflineAudioContext(1, Math.ceil(duration * sampleRate), sampleRate);
  const out = ctx.createGain(); out.gain.value = 0.8; out.connect(ctx.destination);
  let sec = 0, secEnd = PLAN[0][1] * 8;
  for (let i = 0; i < beats.length; i++) {
    while (i >= secEnd) { sec++; secEnd += PLAN[sec][1] * 8; }
    const type = PLAN[sec][0], c = (i % 8) + 1, tb = beats[i];
    const next = beats[i + 1] ?? tb + 60 / BPM, half = (tb + next) / 2;
    if (i >= breakFrom && i < breakFrom + 2) continue;               // брейк — тишина
    const chord = CHORDS[Math.floor((i % 8) / 2)];
    pluck(ctx, out, tb, chord[0]); pluck(ctx, out, half, chord[(i % 2) + 1], 0.08);
    if (type === "intro") continue;                                   // вступление — только гитара
    guira(ctx, out, tb, 0.3);
    if (type === "mambo" || type === "majao") guira(ctx, out, half, 0.15);
    if (c === 1 || c === 5) bass(ctx, out, tb);
    if (c === 4 || c === 8) bongo(ctx, out, tb);
    if (type === "mambo" && (c === 2 || c === 6)) bongo(ctx, out, half);
    if (i === hitAt) crash(ctx, out, tb);
  }
  const buffer = await ctx.startRendering();

  const markup = {
    id: "test-track", title: "Тестовый трек", artist: "синтезирован в браузере",
    duration, bpm: BPM, beats, downbeats, countStart: beats[0], sections, accents,
    danceStart: sections[1].start, verified: true, license: "generated", source: "src/testtrack.js",
  };
  return { buffer, markup };
}
