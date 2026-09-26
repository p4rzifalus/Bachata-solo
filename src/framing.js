/* Проверка «всё тело в кадре».
 * Возвращает одну претензию за раз — самую важную из непройденных.
 */

// Все пороги этапа — здесь. На этапе 3 они уедут в общий объект настроек со слайдерами.
export const FRAMING = {
  minVisibility: 0.6,   // ниже — точку считаем невидимой
  edgeMargin: 0.01,     // точка ближе к краю кадра, чем это (в долях), — «за кадром»
  holdMs: 2000,         // сколько тело должно простоять в кадре, чтобы открылась кнопка «Дальше»
  dropToleranceMs: 300, // короткие провалы детекции не сбрасывают отсчёт
};

// Номера точек MediaPipe Pose
export const P = {
  nose: 0,
  lShoulder: 11, rShoulder: 12,
  lHip: 23, rHip: 24,
  lKnee: 25, rKnee: 26,
  lAnkle: 27, rAnkle: 28,
  lHeel: 29, rHeel: 30,
  lToe: 31, rToe: 32,
};

const FEET      = [P.lAnkle, P.rAnkle, P.lHeel, P.rHeel, P.lToe, P.rToe];
const KNEES     = [P.lKnee, P.rKnee];
const TORSO     = [P.lShoulder, P.rShoulder, P.lHip, P.rHip];

function inFrame(p, cfg) {
  const m = cfg.edgeMargin;
  return p && p.x > m && p.x < 1 - m && p.y > m && p.y < 1 - m;
}

function seen(lm, idxs, cfg) {
  return idxs.every(i => (lm[i]?.visibility ?? 0) >= cfg.minVisibility && inFrame(lm[i], cfg));
}

// Какие точки сейчас не проходят — чтобы подсветить их на скелете.
export function missingPoints(lm, cfg = FRAMING) {
  const bad = new Set();
  for (const i of [...TORSO, ...KNEES, ...FEET])
    if ((lm[i]?.visibility ?? 0) < cfg.minVisibility || !inFrame(lm[i], cfg)) bad.add(i);
  return bad;
}

export function checkFullBody(lm, cfg = FRAMING) {
  if (!lm) return { ok: false, msg: "Встань перед камерой так, чтобы было видно тебя целиком." };

  const feet = seen(lm, FEET, cfg), knees = seen(lm, KNEES, cfg), torso = seen(lm, TORSO, cfg);

  // Ступни пропадают первыми, поэтому о них говорим в первую очередь.
  if (!feet || !knees)
    return { ok: false, msg: "Отойди дальше, нужны <b>ступни в кадре</b>." };
  if (!torso)
    return { ok: false, msg: "Отойди дальше, нужны <b>плечи в кадре</b>." };

  return { ok: true, msg: "Всё тело <b>в кадре</b>. Постой так пару секунд." };
}

/* Удержание: «всё тело в кадре хотя бы 2 секунды».
 * Короткий провал (кадр с плохой детекцией) не сбрасывает отсчёт.
 */
export class HoldTimer {
  constructor(cfg = FRAMING) { this.cfg = cfg; this.reset(); }
  reset() { this.since = 0; this.lastOk = 0; }

  // Возвращает прогресс 0…1.
  update(ok, now) {
    if (ok) {
      if (!this.since) this.since = now;
      this.lastOk = now;
    } else if (this.since && now - this.lastOk > this.cfg.dropToleranceMs) {
      this.since = 0;
    }
    return this.since ? Math.min(1, (now - this.since) / this.cfg.holdMs) : 0;
  }
}
