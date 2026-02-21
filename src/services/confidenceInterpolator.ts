import type { NormalizedLandmark } from '@mediapipe/tasks-vision';

const VIS_THRESHOLD = 0.5;

/**
 * 信頼度が低いランドマークを前後フレームの値で線形補間する。
 *
 * 使い方:
 *   const buf = new ConfidenceInterpolator(bufSize);
 *   // フレームごとに push → get で補間済みランドマークを取得
 *   buf.push(rawLandmarks, timestamp);
 *   const result = buf.getCurrent();
 */
export class ConfidenceInterpolator {
  /** リングバッファ（最大 bufSize フレーム） */
  private buffer: (NormalizedLandmark[] | null)[];
  private head = 0;
  private count = 0;
  private readonly size: number;

  constructor(bufferSize = 3) {
    this.size = Math.max(3, bufferSize);
    this.buffer = new Array(this.size).fill(null);
  }

  /** 新しいフレームをバッファに追加 */
  push(landmarks: NormalizedLandmark[]): void {
    this.buffer[this.head] = landmarks;
    this.head = (this.head + 1) % this.size;
    if (this.count < this.size) this.count++;
  }

  /** 直近の中央フレーム（1フレーム遅延）を前後から補間して返す */
  getCurrent(): NormalizedLandmark[] | null {
    if (this.count < 1) return null;

    // 最新フレーム
    const curIdx = (this.head - 1 + this.size) % this.size;
    const cur = this.buffer[curIdx];
    if (!cur) return null;

    // 前フレーム（あれば）
    const prevIdx = (this.head - 2 + this.size) % this.size;
    const prev = this.count >= 2 ? this.buffer[prevIdx] : null;

    return cur.map((lm, i) => {
      const vis = lm.visibility ?? 0;
      if (vis >= VIS_THRESHOLD) return lm;

      // 前フレームで十分な信頼度があれば補間
      const pLm = prev?.[i];
      const pVis = pLm?.visibility ?? 0;

      if (pLm && pVis >= VIS_THRESHOLD) {
        // 前フレームの座標と現フレームを加重平均
        const w = vis / (vis + pVis + 1e-6);
        return {
          x: lm.x * w + pLm.x * (1 - w),
          y: lm.y * w + pLm.y * (1 - w),
          z: (lm.z ?? 0) * w + (pLm.z ?? 0) * (1 - w),
          visibility: Math.max(vis, pVis * 0.8),
        };
      }

      return lm; // 補間できない
    });
  }

  reset(): void {
    this.buffer.fill(null);
    this.head = 0;
    this.count = 0;
  }
}
