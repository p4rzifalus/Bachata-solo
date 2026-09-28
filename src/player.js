/* Проигрывание по разметке — метронома или трека.
 * Удары ставятся в очередь Web Audio чуть заранее (lookahead) по точному времени,
 * а таймер JS только подкладывает следующие — поэтому темп не зависит от того,
 * насколько занят браузер (распознавание позы, отрисовка).
 * Аудио трека запускается на тех же аудио-часах, с точностью до сэмпла.
 */

import { beatCounts, beatIndexAt } from "./beatmap.js";
import { playBeat, clave } from "./sounds.js";
import { perfToAudio } from "./audio.js";

const LOOKAHEAD = 0.15;   // на сколько секунд вперёд ставим удары
const TICK_MS   = 25;     // как часто подкладываем новые
const LEAD      = 0.12;   // пауза между нажатием «Старт» и первым ударом

export class BeatPlayer {
  constructor(ctx, out) {
    this.ctx = ctx;
    this.out = out;
    this.markup = null;
    this.playing = false;
  }

  /* Время трека (секунды разметки) ↔ время AudioContext: audio = origin + track.
   * from — с какого места трека начать; countInEnd — индекс первого «раз» (удары до него —
   * отсчёт); buffer — аудио трека (нет — синтезированный метроном); clicks — что звучит
   * поверх: "metronome" — весь бачата-метроном, "countin" — только щелчки отсчёта,
   * "overlay" — отсчёт и щелчок на каждый удар (проверить разметку на слух);
   * until — до какого места трека играть.
   */
  start(markup, { from = markup.beats[0] ?? 0, countInEnd, buffer = null, clicks = "metronome", until = markup.duration } = {}) {
    this.stop();
    this.markup = markup;
    this.counts = beatCounts(markup);
    this.countInEnd = countInEnd ?? beatIndexAt(markup.beats, markup.countStart);
    this.clicks = clicks;
    this.origin = this.ctx.currentTime + LEAD - from;
    this.next = Math.max(0, beatIndexAt(markup.beats, from - 1e-6) + 1);
    this.endAt = this.origin + Math.min(until, markup.duration);
    if (buffer) {
      // отсчёт может начаться раньше начала трека — тогда трек стартует со своего нуля
      const off = Math.max(0, from);
      this.gain = this.ctx.createGain();
      this.gain.connect(this.out);
      this.source = this.ctx.createBufferSource();
      this.source.buffer = buffer;
      this.source.connect(this.gain);
      this.source.start(this.origin + off, off);
      // мягко затихаем к концу сессии
      this.gain.gain.setValueAtTime(1, Math.max(this.origin + off, this.endAt - 1.5));
      this.gain.gain.linearRampToValueAtTime(0.0001, this.endAt);
      this.source.stop(this.endAt + 0.05);
    }
    this.playing = true;
    this.schedule();
    this.timer = setInterval(() => this.schedule(), TICK_MS);
  }

  stop() {
    this.playing = false;
    clearInterval(this.timer);
    // уже поставленные в очередь удары доиграют — это доли секунды; трек гасим быстро
    if (this.source) {
      const t = this.ctx.currentTime;
      try {
        this.gain.gain.cancelScheduledValues(t);
        this.gain.gain.setValueAtTime(this.gain.gain.value, t);
        this.gain.gain.linearRampToValueAtTime(0.0001, t + 0.08);
        this.source.stop(t + 0.1);
      } catch (e) {}
      this.source = null;
    }
  }

  schedule() {
    const { beats } = this.markup;
    const horizon = this.ctx.currentTime + LOOKAHEAD;
    while (this.next < beats.length && this.origin + beats[this.next] < horizon) {
      const i = this.next++;
      const t = this.origin + beats[i];
      if (t < this.ctx.currentTime || t > this.endAt) continue;
      const countIn = i < this.countInEnd;
      if (this.clicks === "metronome") playBeat(this.ctx, this.out, t, this.counts[i], countIn);
      else if (countIn) clave(this.ctx, this.out, t, this.counts[i] === 8);
      else if (this.clicks === "overlay") clave(this.ctx, this.out, t, this.counts[i] === 1);
    }
    if (this.ctx.currentTime > this.endAt) this.stop();
  }

  // Время трека, которое сейчас слышно из динамика (с поправкой на задержку вывода).
  heardTime() {
    return perfToAudio(performance.now()) - this.origin;
  }

  // Время удара i по аудио-часам.
  beatTime(i) { return this.origin + this.markup.beats[i]; }

  /* Привязка события (время по аудио-часам) к ближайшему удару:
   * опоздание в мс (минус — раньше, плюс — позже) и счёт 1–8.
   */
  match(t) {
    if (!this.markup) return null;
    const b = this.markup.beats, tt = t - this.origin;
    let i = beatIndexAt(b, tt);
    if (i < 0) i = 0;
    else if (i + 1 < b.length && b[i + 1] - tt < tt - b[i]) i++;
    return { index: i, count: this.counts[i], countIn: i < this.countInEnd, offsetMs: (tt - b[i]) * 1000 };
  }

  // Что показать на экране прямо сейчас: номер удара, счёт 1–8 и идёт ли ещё отсчёт.
  now() {
    if (!this.markup) return null;
    const i = beatIndexAt(this.markup.beats, this.heardTime());
    if (i < 0) return null;
    return { index: i, count: this.counts[i], countIn: i < this.countInEnd };
  }
}
