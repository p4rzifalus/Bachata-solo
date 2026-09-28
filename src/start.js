/* Проверка старта: с какого счёта и в какую сторону начат танец,
 * и дальше — в ту ли сторону шаг на каждом «раз».
 * Чистая логика, без DOM: на вход — постановки стоп, привязанные к ударам.
 *
 * dir — куда ехала стопа по картинке камеры (+1 — вправо по картинке). Человек стоит
 * к камере лицом, поэтому вправо по картинке — это его левая сторона.
 */

export const dirWord = (d) => (d > 0 ? "влево" : "вправо");

const START_CONF = 0.5;   // уверенность постановки, ниже — переминание, а не шаг
const FOLLOW = 3;         // сколько уверенных постановок должно идти следом…
const FOLLOW_BEATS = 3.5; // …за столько ударов (2, 3 и тап на 4)

export class StartCheck {
  /* oneDir — "left" или "right": куда шаг на раз; firstOne — время первого «раз» после
   * отсчёта по аудио-часам; period — длительность удара, с. */
  constructor(oneDir, firstOne, period) {
    this.want = oneDir === "left" ? 1 : -1;
    this.firstOne = firstOne;
    this.period = period;
    this.start = null;
    this.ones = { n: 0, ok: 0 };
    this.candidates = [];
  }

  /* land — { t, dir, conf, count, countIn, offsetMs }. Возвращает итог старта,
   * когда он определился (один раз), иначе null. */
  push(land) {
    if (land.t < this.firstOne - this.period / 2) return null;   // шаги во время отсчёта не в счёт
    let decided = null;

    /* Начало танца — первый уверенный шаг, за которым идут ещё шаги подряд, как в
     * танце. Одиночное движение — переминание или «поставил ногу на место» перед
     * вступлением — началом не считается.
     */
    if (!this.start) {
      this.candidates.push(land);
      const win = FOLLOW_BEATS * this.period;
      while (this.candidates.length) {
        const c = this.candidates[0];
        const after = this.candidates.filter(x => x.t > c.t && x.t <= c.t + win && x.conf >= START_CONF).length;
        if (c.conf >= START_CONF && after >= FOLLOW) { decided = this.decide(c); break; }
        if (c.conf < START_CONF || land.t > c.t + win) this.candidates.shift(); else break;
      }
    }

    // после начала — на каждом «раз»: в ту ли сторону
    if (this.start && !decided && land.count === 1 && !land.countIn) {
      this.ones.n++;
      if (land.dir === this.want) this.ones.ok++;
      this.lastOneDir = land.dir;
    }
    return decided;
  }

  decide(c) {
    let verdict, ok = false;
    if (c.count !== 1) verdict = `Начал с ${c.count} — вход должен быть на раз`;
    else if (c.dir !== this.want) verdict = `Начал с раз, но шагнул ${dirWord(c.dir)} — на раз шаг ${dirWord(this.want)}`;
    else { verdict = `Начал с раз, шаг ${dirWord(c.dir)} ✓`; ok = true; }
    this.start = { verdict, ok, t: c.t, count: c.count, dir: dirWord(c.dir), offsetMs: Math.round(c.offsetMs) };
    // «раз», которые уже прошли с момента начала, тоже засчитываем
    for (const x of this.candidates) {
      if (x.t >= c.t && x.count === 1 && !x.countIn) {
        this.ones.n++;
        if (x.dir === this.want) this.ones.ok++;
        this.lastOneDir = x.dir;
      }
    }
    this.candidates = [];
    return this.start;
  }

  onesText() {
    if (!this.ones.n) return "";
    const w = dirWord(this.want);
    return `На раз ${w}: ${this.ones.ok} из ${this.ones.n}` + (this.lastOneDir === this.want ? "" : ` · сейчас ${dirWord(this.lastOneDir)}`);
  }
}
