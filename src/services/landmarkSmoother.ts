import type { NormalizedLandmark } from '@mediapipe/tasks-vision';

/**
 * One-Euro Filter
 * 静止時は強く平滑化、高速動作時は追従。
 * ゴルフスイングのように 静→急動→静 の動きに最適。
 *
 * @see https://cristal.univ-lille.fr/~casiez/1euro/
 */
class OneEuroFilter {
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev: number | null = null;

  constructor(minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  private alpha(te: number, cutoff: number): number {
    const r = 2 * Math.PI * cutoff * te;
    return r / (r + 1);
  }

  filter(x: number, t: number): number {
    if (this.tPrev === null || this.xPrev === null) {
      this.xPrev = x;
      this.tPrev = t;
      return x;
    }

    const te = t - this.tPrev;
    if (te <= 0) return this.xPrev;

    // 速度推定（ローパスフィルタ付き）
    const dx = (x - this.xPrev) / te;
    const adx = this.alpha(te, this.dCutoff);
    const dxSmoothed = adx * dx + (1 - adx) * this.dxPrev;

    // 動的カットオフ — 速い動きほどカットオフが高い（追従する）
    const cutoff = this.minCutoff + this.beta * Math.abs(dxSmoothed);
    const ax = this.alpha(te, cutoff);
    const xFiltered = ax * x + (1 - ax) * this.xPrev;

    this.xPrev = xFiltered;
    this.dxPrev = dxSmoothed;
    this.tPrev = t;
    return xFiltered;
  }

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }
}

/**
 * 全ランドマーク (33 点 × xyz) を One-Euro Filter で平滑化する。
 * フレームごとに smooth() を呼び出す。
 */
export class LandmarkSmoother {
  private filters = new Map<string, OneEuroFilter>();
  private minCutoff: number;
  private beta: number;

  /**
   * @param minCutoff 低速時のカットオフ周波数（小さいほど平滑化が強い）
   * @param beta 速度適応パラメータ（大きいほど高速動作への追従が早い）
   */
  constructor(minCutoff = 1.7, beta = 0.01) {
    this.minCutoff = minCutoff;
    this.beta = beta;
  }

  smooth(landmarks: NormalizedLandmark[], timestamp: number): NormalizedLandmark[] {
    return landmarks.map((lm, i) => {
      const kx = `${i}_x`;
      const ky = `${i}_y`;
      const kz = `${i}_z`;

      if (!this.filters.has(kx)) {
        this.filters.set(kx, new OneEuroFilter(this.minCutoff, this.beta));
        this.filters.set(ky, new OneEuroFilter(this.minCutoff, this.beta));
        this.filters.set(kz, new OneEuroFilter(this.minCutoff, this.beta));
      }

      return {
        x: this.filters.get(kx)!.filter(lm.x, timestamp),
        y: this.filters.get(ky)!.filter(lm.y, timestamp),
        z: this.filters.get(kz)!.filter(lm.z ?? 0, timestamp),
        visibility: lm.visibility,
      };
    });
  }

  reset(): void {
    this.filters.clear();
  }
}
