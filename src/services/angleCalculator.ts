import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import { POSE } from './skeletonRenderer';

/** 角度情報 */
export interface AngleInfo {
  label: string;
  angle: number; // 度数法
  x: number; // 表示位置 (正規化座標)
  y: number;
  visibility: number; // 表示に使う信頼度
}

/**
 * 3点のランドマークから角度を計算する（度数法）
 * a → b → c の b における角度
 */
function calcAngle(
  a: NormalizedLandmark,
  b: NormalizedLandmark,
  c: NormalizedLandmark,
): number {
  const ba = { x: a.x - b.x, y: a.y - b.y };
  const bc = { x: c.x - b.x, y: c.y - b.y };

  const dot = ba.x * bc.x + ba.y * bc.y;
  const magBA = Math.sqrt(ba.x * ba.x + ba.y * ba.y);
  const magBC = Math.sqrt(bc.x * bc.x + bc.y * bc.y);

  if (magBA === 0 || magBC === 0) return 0;

  const cosAngle = Math.max(-1, Math.min(1, dot / (magBA * magBC)));
  return (Math.acos(cosAngle) * 180) / Math.PI;
}

/**
 * 2点間の水平角度（度数法）を計算する
 * 水平が0度、右肩下がりが正、左肩下がりが負
 */
function calcHorizontalAngle(
  left: NormalizedLandmark,
  right: NormalizedLandmark,
): number {
  const dx = right.x - left.x;
  const dy = right.y - left.y;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

/**
 * ゴルフスイングに重要な関節角度を計算する
 */
export function calculateAngles(
  landmarks: NormalizedLandmark[],
): AngleInfo[] {
  if (landmarks.length < 33) return [];

  const angles: AngleInfo[] = [];

  const lShoulder = landmarks[POSE.LEFT_SHOULDER];
  const rShoulder = landmarks[POSE.RIGHT_SHOULDER];
  const lElbow = landmarks[POSE.LEFT_ELBOW];
  const rElbow = landmarks[POSE.RIGHT_ELBOW];
  const lWrist = landmarks[POSE.LEFT_WRIST];
  const rWrist = landmarks[POSE.RIGHT_WRIST];
  const lHip = landmarks[POSE.LEFT_HIP];
  const rHip = landmarks[POSE.RIGHT_HIP];
  const lKnee = landmarks[POSE.LEFT_KNEE];
  const rKnee = landmarks[POSE.RIGHT_KNEE];
  const lAnkle = landmarks[POSE.LEFT_ANKLE];
  const rAnkle = landmarks[POSE.RIGHT_ANKLE];

  // 肩の回転角（水平からの傾き）
  {
    const vis = Math.min(lShoulder.visibility ?? 0, rShoulder.visibility ?? 0);
    if (vis > 0.4) {
      const angle = calcHorizontalAngle(lShoulder, rShoulder);
      angles.push({
        label: '肩',
        angle: Math.round(angle),
        x: (lShoulder.x + rShoulder.x) / 2,
        y: (lShoulder.y + rShoulder.y) / 2 - 0.04,
        visibility: vis,
      });
    }
  }

  // 左肘の角度
  {
    const vis = Math.min(
      lShoulder.visibility ?? 0,
      lElbow.visibility ?? 0,
      lWrist.visibility ?? 0,
    );
    if (vis > 0.4) {
      const angle = calcAngle(lShoulder, lElbow, lWrist);
      angles.push({
        label: '左肘',
        angle: Math.round(angle),
        x: lElbow.x,
        y: lElbow.y - 0.03,
        visibility: vis,
      });
    }
  }

  // 右肘の角度
  {
    const vis = Math.min(
      rShoulder.visibility ?? 0,
      rElbow.visibility ?? 0,
      rWrist.visibility ?? 0,
    );
    if (vis > 0.4) {
      const angle = calcAngle(rShoulder, rElbow, rWrist);
      angles.push({
        label: '右肘',
        angle: Math.round(angle),
        x: rElbow.x,
        y: rElbow.y - 0.03,
        visibility: vis,
      });
    }
  }

  // 腰の回転角（水平からの傾き）
  {
    const vis = Math.min(lHip.visibility ?? 0, rHip.visibility ?? 0);
    if (vis > 0.4) {
      const angle = calcHorizontalAngle(lHip, rHip);
      angles.push({
        label: '腰',
        angle: Math.round(angle),
        x: (lHip.x + rHip.x) / 2,
        y: (lHip.y + rHip.y) / 2 + 0.04,
        visibility: vis,
      });
    }
  }

  // 左膝の角度
  {
    const vis = Math.min(
      lHip.visibility ?? 0,
      lKnee.visibility ?? 0,
      lAnkle.visibility ?? 0,
    );
    if (vis > 0.4) {
      const angle = calcAngle(lHip, lKnee, lAnkle);
      angles.push({
        label: '左膝',
        angle: Math.round(angle),
        x: lKnee.x,
        y: lKnee.y - 0.03,
        visibility: vis,
      });
    }
  }

  // 右膝の角度
  {
    const vis = Math.min(
      rHip.visibility ?? 0,
      rKnee.visibility ?? 0,
      rAnkle.visibility ?? 0,
    );
    if (vis > 0.4) {
      const angle = calcAngle(rHip, rKnee, rAnkle);
      angles.push({
        label: '右膝',
        angle: Math.round(angle),
        x: rKnee.x,
        y: rKnee.y - 0.03,
        visibility: vis,
      });
    }
  }

  return angles;
}

/**
 * Canvas に角度ラベルを描画する
 */
export function drawAngles(
  ctx: CanvasRenderingContext2D,
  angles: AngleInfo[],
  width: number,
  height: number,
): void {
  ctx.font = 'bold 13px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';

  for (const info of angles) {
    const px = info.x * width;
    const py = info.y * height;
    const text = `${info.label} ${info.angle}°`;

    // 背景
    const metrics = ctx.measureText(text);
    const padX = 4;
    const padY = 2;
    const bgW = metrics.width + padX * 2;
    const bgH = 16 + padY * 2;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
    ctx.beginPath();
    ctx.roundRect(px - bgW / 2, py - bgH, bgW, bgH, 4);
    ctx.fill();

    // テキスト
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, px, py - padY);
  }
}
