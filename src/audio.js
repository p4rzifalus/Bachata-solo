/* Один AudioContext на всё приложение. Его время (currentTime) — главные часы:
 * по ним ставятся удары, по ним же будут сравниваться шаги.
 */

let ctx = null;
let master = null;

// Создавать только по нажатию кнопки — иначе iOS не даст играть звук.
export function audio() {
  if (!ctx) {
    // iPhone: без этого Web Audio молчит, когда включён беззвучный режим (Safari 16.4+).
    try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch (e) {}
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

export function masterOut() { audio(); return master; }

// Сколько секунд проходит от «поставили звук в очередь» до «он вышел из динамика».
// Safari не сообщает outputLatency — тогда остаётся только baseLatency, остальное поправит калибровка.
export function outputLatency(c = ctx) {
  if (!c) return 0;
  return (c.outputLatency || 0) + (c.baseLatency || 0);
}

/* Перевод времени performance.now() (мс) на аудио-часы (с) — в «слышимое» время:
 * какой момент звуковой дорожки звучит из динамика в эту миллисекунду.
 * getOutputTimestamp даёт пару «время аудио ↔ время страницы» уже с учётом задержки вывода.
 * Сдвиг между часами берём медианой по последним замерам, чтобы не дёргался.
 */
const offsets = [];
export function perfToAudio(perfMs) {
  const c = audio();
  let off;
  const ts = c.getOutputTimestamp?.();
  if (ts && ts.performanceTime > 0) off = ts.contextTime - ts.performanceTime / 1000;
  else off = c.currentTime - outputLatency(c) - performance.now() / 1000;
  offsets.push(off);
  if (offsets.length > 60) offsets.shift();
  const sorted = [...offsets].sort((a, b) => a - b);
  return perfMs / 1000 + sorted[sorted.length >> 1];
}
