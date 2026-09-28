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
