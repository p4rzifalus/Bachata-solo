/* Проигрывание по разметке.
 * Удары ставятся в очередь Web Audio чуть заранее (lookahead) по точному времени,
 * а таймер JS только подкладывает следующие — поэтому темп не зависит от того,
 * насколько занят браузер (распознавание позы, отрисовка).
 */

import { beatCounts, beatIndexAt } from "./beatmap.js";
import { playBeat } from "./sounds.js";
import { outputLatency } from "./audio.js";

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

  /* Время трека (секунды разметки) ↔ время AudioContext: audio = origin + track. */
  start(markup, from = markup.beats[0] ?? 0) {
    this.stop();
    this.markup = markup;
    this.counts = beatCounts(markup);
    this.countInEnd = beatIndexAt(markup.beats, markup.countStart);   // индекс первого «раз»
    this.origin = this.ctx.currentTime + LEAD - from;
    this.next = Math.max(0, beatIndexAt(markup.beats, from - 1e-6) + 1);
    this.endAt = this.origin + markup.duration;
    this.playing = true;
    this.schedule();
    this.timer = setInterval(() => this.schedule(), TICK_MS);
  }

  stop() {
    this.playing = false;
    clearInterval(this.timer);
    // уже поставленные в очередь удары доиграют — это доли секунды
  }

  schedule() {
    const { beats } = this.markup;
    const horizon = this.ctx.currentTime + LOOKAHEAD;
    while (this.next < beats.length && this.origin + beats[this.next] < horizon) {
      const i = this.next++;
      const t = this.origin + beats[i];
      if (t >= this.ctx.currentTime) playBeat(this.ctx, this.out, t, this.counts[i], i < this.countInEnd);
    }
    if (this.ctx.currentTime > this.endAt) this.stop();
  }

  // Время трека, которое сейчас слышно из динамика (с поправкой на задержку вывода).
  heardTime() {
    return this.ctx.currentTime - outputLatency(this.ctx) - this.origin;
  }

  // Что показать на экране прямо сейчас: номер удара, счёт 1–8 и идёт ли ещё отсчёт.
  now() {
    if (!this.markup) return null;
    const i = beatIndexAt(this.markup.beats, this.heardTime());
    if (i < 0) return null;
    return { index: i, count: this.counts[i], countIn: i < this.countInEnd };
  }
}
