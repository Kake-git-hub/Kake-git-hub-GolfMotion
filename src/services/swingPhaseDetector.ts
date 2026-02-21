import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import { POSE } from './skeletonRenderer';

/**
 * スイングフェーズ定義
 */
export type SwingPhase =
  | 'address'      // アドレス
  | 'takeaway'     // テイクバック
  | 'top'          // トップ
  | 'downswing'    // ダウンスイング
  | 'impact'       // インパクト
  | 'follow'       // フォロースルー
  | 'finish'       // フィニッシュ
  | 'unknown';

export interface SwingPhaseInfo {
  phase: SwingPhase;
  label: string;
  color: string;
}

const PHASE_LABELS: Record<SwingPhase, { label: string; color: string }> = {
  address:   { label: 'アドレス',         color: '#88ccff' },
  takeaway:  { label: 'テイクバック',     color: '#66ddaa' },
  top:       { label: 'トップ',           color: '#ffcc44' },
  downswing: { label: 'ダウンスイング',   color: '#ff8844' },
  impact:    { label: 'インパクト',       color: '#ff4466' },
  follow:    { label: 'フォロースルー',   color: '#cc66ff' },
  finish:    { label: 'フィニッシュ',     color: '#8888ff' },
  unknown:   { label: '---',             color: '#666666' },
};

/**
 * 2点間の水平角度 (deg)
 */
function hAngle(a: NormalizedLandmark, b: NormalizedLandmark): number {
  return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
}

/**
 * フレームごとのランドマーク履歴からスイングフェーズを自動検出する。
 *
 * 全フレーム一括解析: analyze(allFrames) → SwingPhase[] (各フレームのフェーズ)
 *
 * アルゴリズム:
 * 1. リードハンド（左手首）のY座標トレースを取得
 * 2. 極小/極大を探してトップ/フィニッシュを特定
 * 3. 手首のX方向速度の極大でインパクトを推定
 * 4. その間をアドレス/テイクバック/ダウンスイング/フォローに分割
 */
export class SwingPhaseDetector {
  /**
   * 全フレームのランドマーク配列を渡して各フレームのフェーズを返す
   * @param frames 全フレームのランドマーク (index = フレーム番号)
   * @param fps 入力動画のFPS（時間計算用）
   */
  analyze(frames: NormalizedLandmark[][], fps = 30): SwingPhase[] {
    const n = frames.length;
    if (n < 5) return new Array(n).fill('unknown');

    // リードハンドの Y 座標列 (右打ちの場合左手首がリードハンド)
    const wristY = frames.map(lm => {
      const lw = lm[POSE.LEFT_WRIST];
      const rw = lm[POSE.RIGHT_WRIST];
      // 信頼度が高い方を使う
      const lv = lw?.visibility ?? 0;
      const rv = rw?.visibility ?? 0;
      return lv >= rv ? (lw?.y ?? 0.5) : (rw?.y ?? 0.5);
    });

    // 手首のX座標（速度計算用）
    const wristX = frames.map(lm => {
      const lw = lm[POSE.LEFT_WRIST];
      const rw = lm[POSE.RIGHT_WRIST];
      const lv = lw?.visibility ?? 0;
      const rv = rw?.visibility ?? 0;
      return lv >= rv ? (lw?.x ?? 0.5) : (rw?.x ?? 0.5);
    });

    // 肩の回転角トレース
    const shoulderAngle = frames.map(lm => {
      const ls = lm[POSE.LEFT_SHOULDER];
      const rs = lm[POSE.RIGHT_SHOULDER];
      if ((ls?.visibility ?? 0) < 0.3 || (rs?.visibility ?? 0) < 0.3) return 0;
      return hAngle(ls, rs);
    });

    // === ステップ1: 平滑化（3フレーム移動平均） ===
    const smoothY = movingAvg(wristY, 3);
    const smoothX = movingAvg(wristX, 3);

    // === ステップ2: トップ位置検出（手首Y座標が最も小さい = 最も上） ===
    // 前半2/3の範囲で検索（フィニッシュと間違えないように）
    const searchEnd = Math.floor(n * 0.7);
    let topFrame = 0;
    let minY = Infinity;
    for (let i = Math.floor(n * 0.1); i < searchEnd; i++) {
      if (smoothY[i] < minY) {
        minY = smoothY[i];
        topFrame = i;
      }
    }

    // === ステップ3: インパクト位置検出（トップ以降、X方向速度の極大） ===
    const xSpeed: number[] = [];
    for (let i = 0; i < n; i++) {
      if (i === 0) { xSpeed.push(0); continue; }
      xSpeed.push(Math.abs(smoothX[i] - smoothX[i - 1]) * fps);
    }
    const smoothSpeed = movingAvg(xSpeed, 3);

    let impactFrame = topFrame + 1;
    let maxSpeed = 0;
    for (let i = topFrame + 2; i < Math.min(n - 1, topFrame + Math.floor(n * 0.5)); i++) {
      if (smoothSpeed[i] > maxSpeed) {
        maxSpeed = smoothSpeed[i];
        impactFrame = i;
      }
    }

    // === ステップ4: フィニッシュ検出（インパクト以降、手首Y座標が再び最小に近い所） ===
    let finishFrame = n - 1;
    // 速度が一定以下にフォールバックした最初のフレーム
    const speedThreshold = maxSpeed * 0.15;
    for (let i = impactFrame + 3; i < n; i++) {
      if (smoothSpeed[i] < speedThreshold) {
        finishFrame = i;
        break;
      }
    }

    // === ステップ5: テイクバック開始（アドレスからの肩回転開始点） ===
    const baseAngle = shoulderAngle[0] ?? 0;
    let takeawayFrame = Math.max(1, Math.floor(topFrame * 0.1));
    for (let i = 1; i < topFrame; i++) {
      if (Math.abs(shoulderAngle[i] - baseAngle) > 3) {
        takeawayFrame = i;
        break;
      }
    }

    // === ステップ6: 各フレームにフェーズを割り当て ===
    const phases: SwingPhase[] = new Array(n).fill('unknown');
    for (let i = 0; i < n; i++) {
      if (i < takeawayFrame) {
        phases[i] = 'address';
      } else if (i < topFrame) {
        phases[i] = 'takeaway';
      } else if (i === topFrame) {
        phases[i] = 'top';
      } else if (i < impactFrame) {
        phases[i] = 'downswing';
      } else if (i >= impactFrame && i <= impactFrame + 1) {
        phases[i] = 'impact';
      } else if (i < finishFrame) {
        phases[i] = 'follow';
      } else {
        phases[i] = 'finish';
      }
    }

    return phases;
  }
}

/** 移動平均 */
function movingAvg(arr: number[], window: number): number[] {
  const half = Math.floor(window / 2);
  return arr.map((_, i) => {
    let sum = 0;
    let count = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < arr.length) {
        sum += arr[j];
        count++;
      }
    }
    return sum / count;
  });
}

/**
 * フェーズ情報を取得するヘルパー
 */
export function getPhaseInfo(phase: SwingPhase): SwingPhaseInfo {
  const info = PHASE_LABELS[phase];
  return { phase, ...info };
}

/**
 * フェーズラベルをキャンバスに描画する
 */
export function drawPhaseLabel(
  ctx: CanvasRenderingContext2D,
  phase: SwingPhase,
  canvasWidth: number,
): void {
  const info = getPhaseInfo(phase);
  if (phase === 'unknown') return;

  const text = info.label;
  ctx.font = 'bold 16px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const metrics = ctx.measureText(text);
  const padX = 10;
  const padY = 6;
  const bgW = metrics.width + padX * 2;
  const bgH = 20 + padY * 2;
  const cx = canvasWidth / 2;
  const cy = 10;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.beginPath();
  ctx.roundRect(cx - bgW / 2, cy, bgW, bgH, 6);
  ctx.fill();

  ctx.fillStyle = info.color;
  ctx.fillText(text, cx, cy + padY);
}

/**
 * タイムラインにフェーズの色帯を描画する
 * @param ctx 描画先 canvas context
 * @param phases フェーズ配列（フレーム数分）
 * @param width キャンバス幅
 * @param height 帯の高さ
 * @param y 描画Y位置
 */
export function drawPhaseTimeline(
  ctx: CanvasRenderingContext2D,
  phases: SwingPhase[],
  width: number,
  height: number,
  y: number,
): void {
  const n = phases.length;
  if (n === 0) return;

  const segW = width / n;
  for (let i = 0; i < n; i++) {
    const info = PHASE_LABELS[phases[i]];
    ctx.fillStyle = info.color + '80';  // 半透明
    ctx.fillRect(i * segW, y, segW + 0.5, height);
  }
}
