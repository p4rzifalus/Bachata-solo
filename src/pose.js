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
  }

  /* undefined — кадр не обновился, считать заново незачем;
   * null — человека нет; иначе { landmarks, ts }.
   * ts — время кадра в мс по performance.now(). На этапе 3 оно будет
   * переводиться на аудио-часы (AudioContext.currentTime).
   */
  detect() {
    if (!this.landmarker || this.video.readyState < 2) return undefined;
    if (this.video.currentTime === this.lastVideoTime) return undefined;
    this.lastVideoTime = this.video.currentTime;
    // модель требует строго растущих меток времени
    const ts = Math.max(performance.now(), this.lastTs + 0.001);
    this.lastTs = ts;
    const lm = this.landmarker.detectForVideo(this.video, ts).landmarks?.[0];
    return lm ? { landmarks: lm, ts } : null;
  }
}
