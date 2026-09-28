/* Камера и модель позы. Ничего не знает ни про DOM-разметку, ни про танец.
 * Подход взят из 04-fitness: MediaPipe Tasks Vision с CDN, режим VIDEO.
 */

import { PoseLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

const WASM  = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
// lite — самая быстрая на телефоне. Если голеностопы будут сильно дрожать,
// попробовать full (точнее, но fps на iPhone может просесть):
// pose_landmarker_full/float16/1/pose_landmarker_full.task
const MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

export class PoseEngine {
  constructor(video) {
    this.video = video;
    this.landmarker = null;
    this.stream = null;
    this.lastVideoTime = -1;
    this.lastTs = 0;
    this.camFrames = 0;      // для счётчика FPS камеры
    this.frameMeta = null;   // метаданные последнего кадра камеры
  }

  /* requestVideoFrameCallback сообщает, когда кадр был снят (captureTime) или
   * показан (presentationTime) — это точнее, чем «когда мы до него добрались».
   */
  watchFrames() {
    if (this.watching || !("requestVideoFrameCallback" in HTMLVideoElement.prototype)) return;
    this.watching = true;
    const tick = (now, meta) => {
      this.camFrames++;
      this.frameMeta = meta;
      this.video.requestVideoFrameCallback(tick);
    };
    this.video.requestVideoFrameCallback(tick);
  }

  async initModel() {
    if (this.landmarker) return;
    const fileset = await FilesetResolver.forVisionTasks(WASM);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    // На части устройств GPU-делегат не поднимается — тогда считаем на процессоре.
    try {
      this.landmarker = await PoseLandmarker.createFromOptions(fileset, opts("GPU"));
      this.delegate = "GPU";
    } catch (e) {
      this.landmarker = await PoseLandmarker.createFromOptions(fileset, opts("CPU"));
      this.delegate = "CPU";
    }
  }

  async startCamera(facing) {
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.watching = false;
    this.watchFrames();
  }

  /* undefined — кадр не обновился, считать заново незачем;
   * null — человека нет; иначе { landmarks, frameTime, source }.
   * frameTime — время кадра в мс по performance.now(); app.js переводит его на аудио-часы.
   */
  detect() {
    if (!this.landmarker || this.video.readyState < 2) return undefined;
    if (this.video.currentTime === this.lastVideoTime) return undefined;
    this.lastVideoTime = this.video.currentTime;
    // модель требует строго растущих меток времени
    const ts = Math.max(performance.now(), this.lastTs + 0.001);
    this.lastTs = ts;
    const lm = this.landmarker.detectForVideo(this.video, ts).landmarks?.[0];
    if (!lm) return null;
    const m = this.frameMeta;
    let frameTime = ts, source = "now";
    if (m && Math.abs(m.mediaTime - this.lastVideoTime) < 1e-3) {
      if (m.captureTime) { frameTime = m.captureTime; source = "capture"; }
      else if (m.presentationTime) { frameTime = m.presentationTime; source = "presentation"; }
    }
    return { landmarks: lm, frameTime, source };
  }
}
