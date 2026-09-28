/* Разметка трека (формат описан в SPEC.md) и счёт 1–8 по ней.
 * Движок работает только с разметкой и не знает, откуда она: метроном, трек или свой mp3.
 */

// Разметка для встроенного метронома. Первые countIn ударов — отсчёт «5-6-7-8»,
// первый «раз» (countStart) — сразу после него.
export function metronomeMarkup({ bpm, countIn = 4, duration = 600 }) {
  const period = 60 / bpm;
  const n = Math.floor(duration / period);
  // Каждый удар считается от нуля, а не прибавлением к предыдущему — ошибка не копится.
  const beats = Array.from({ length: n }, (_, i) => round(i * period));
  const downbeats = beats.filter((_, i) => i >= countIn && (i - countIn) % 8 === 0);
  const countStart = beats[countIn];
  return {
    id: `metronome-${bpm}`,
    title: `Метроном ${bpm} BPM`,
    artist: "",
    duration: round(n * period),
    bpm,
    beats,
    downbeats,
    countStart,
    sections: [],
    accents: [],
    danceStart: countStart,
    verified: true,
    license: "generated",
    source: "",
  };
}

const round = (t) => Math.round(t * 1e4) / 1e4;   // 0,1 мс — точнее не нужно

// Номер последнего удара, который уже наступил к моменту t; -1, если ни одного.
export function beatIndexAt(beats, t) {
  let lo = 0, hi = beats.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function nearestIndex(beats, t) {
  const i = beatIndexAt(beats, t);
  if (i < 0) return 0;
  if (i + 1 < beats.length && beats[i + 1] - t < t - beats[i]) return i + 1;
  return i;
}

/* Счёт 1–8 для каждого удара.
 * Отсчёт идёт от ближайшего предыдущего «раз», поэтому ручная правка одного «раз»
 * в редакторе сдвигает счёт только до следующего.
 * Удары до первого «раз» получают счёт с конца восьмёрки: …5, 6, 7, 8 → 1.
 */
export function beatCounts(markup) {
  const { beats, downbeats } = markup;
  const d = downbeats.length ? downbeats.map(t => nearestIndex(beats, t)) : [0];
  const counts = new Array(beats.length);
  let k = 0;
  for (let i = 0; i < beats.length; i++) {
    while (k + 1 < d.length && d[k + 1] <= i) k++;
    counts[i] = (((i - d[k]) % 8) + 8) % 8 + 1;
  }
  return counts;
}
