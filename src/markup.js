/* Разметка трека: проверка файла и приведение к виду, с которым работает движок.
 * Формат описан в SPEC.md. Движок не знает, откуда разметка — метроном, каталог или свой файл.
 */

export const SECTION_TYPES = ["intro", "derecho", "majao", "mambo", "break", "outro"];

const num = (x) => typeof x === "number" && Number.isFinite(x);

/* Возвращает { markup, problems, notes }. markup — null, если файлом пользоваться нельзя.
 * audioDuration (необязательно) — длительность выбранного аудио, с.
 */
export function normalizeMarkup(raw, audioDuration) {
  const problems = [], notes = [];
  if (!raw || typeof raw !== "object") return { markup: null, problems: ["Это не JSON разметки"], notes };

  let beats = Array.isArray(raw.beats) ? raw.beats.filter(num).sort((a, b) => a - b) : [];
  if (beats.length < 2) return { markup: null, problems: ["В разметке нет ударов (beats) — нужно хотя бы 2"], notes };

  const duration = num(raw.duration) ? raw.duration : audioDuration ?? beats.at(-1) + 1;
  const gaps = beats.slice(1).map((b, i) => b - beats[i]);
  const tail = gaps.slice(-8).sort((a, b) => a - b);
  const period = tail[tail.length >> 1];
  const bpm = num(raw.bpm) ? raw.bpm : Math.round(60 / period);

  // Разметили кусок — продолжаем сетку до конца трека по последнему интервалу.
  // Так для проверки хватает одной размеченной восьмёрки.
  const marked = beats.length;
  const end = audioDuration ?? duration;
  if (beats.at(-1) + period < end) {
    const last = beats.at(-1);
    for (let k = 1; last + k * period < end; k++) beats.push(+(last + k * period).toFixed(4));
    notes.push(`Размечено ${marked} ударов — дальше сетка продолжена ровно по ${Math.round(60 / period)} BPM`);
  }
  // и назад, к началу трека: перед первым «раз» нужны удары для отсчёта «5-6-7-8»
  const head = [];
  for (let t = beats[0] - period; t >= 0; t -= period) head.unshift(+t.toFixed(4));
  beats = head.concat(beats);

  // «Раз» — каждой восьмёрки. Если их нет, считаем первый удар «раз».
  let downbeats = Array.isArray(raw.downbeats) ? raw.downbeats.filter(num).sort((a, b) => a - b) : [];
  if (!downbeats.length) {
    downbeats = [beats[0]];
    problems.push("Нет «раз» (downbeats) — считаю первый удар за «раз»");
  }
  // продолжаем «раз» каждые 8 ударов в обе стороны от размеченных
  const idx = (t) => beats.reduce((b, x, i) => (Math.abs(x - t) < Math.abs(beats[b] - t) ? i : b), 0);
  for (let i = idx(downbeats.at(-1)) + 8; i < beats.length; i += 8) downbeats.push(beats[i]);
  for (let i = idx(downbeats[0]) - 8; i >= 0; i -= 8) downbeats.unshift(beats[i]);

  const countStart = num(raw.countStart) ? raw.countStart : downbeats[0];
  const danceStart = num(raw.danceStart) ? raw.danceStart : countStart;

  const sections = (Array.isArray(raw.sections) ? raw.sections : [])
    .filter(s => s && num(s.start))
    .map(s => ({ start: s.start, type: SECTION_TYPES.includes(s.type) ? s.type : "derecho" }))
    .sort((a, b) => a.start - b.start);
  const accents = (Array.isArray(raw.accents) ? raw.accents : [])
    .filter(a => a && num(a.time))
    .map(a => ({ time: a.time, type: a.type === "break" ? "break" : "hit", ...(num(a.duration) && { duration: a.duration }) }));

  // Своё аудио: длительность должна совпасть с разметкой ±1 с
  if (audioDuration != null && num(raw.duration) && Math.abs(audioDuration - raw.duration) > 1) {
    problems.push(`Похоже, это другая версия трека, разметка может не совпасть (аудио ${fmt(audioDuration)}, в разметке ${fmt(raw.duration)})`);
  }
  if (raw.verified !== true) notes.push("Разметка не проверена человеком");

  return {
    markup: {
      id: raw.id || "track", title: raw.title || "Без названия", artist: raw.artist || "",
      duration: end, bpm, beats, downbeats, countStart, danceStart, sections, accents,
      verified: raw.verified === true, license: raw.license || "", source: raw.source || "",
    },
    problems, notes,
  };
}

export const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

// Часть трека в момент t (время трека).
export function sectionAt(sections, t) {
  let cur = null;
  for (const s of sections) if (s.start <= t) cur = s; else break;
  return cur?.type ?? null;
}
