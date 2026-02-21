import type { NormalizedLandmark } from '@mediapipe/tasks-vision';

/**
 * MediaPipe Pose Landmark インデックス定義
 * https://developers.google.com/mediapipe/solutions/vision/pose_landmarker
 */
export const POSE = {
  NOSE: 0,
  LEFT_EYE_INNER: 1,
  LEFT_EYE: 2,
  LEFT_EYE_OUTER: 3,
  RIGHT_EYE_INNER: 4,
  RIGHT_EYE: 5,
  RIGHT_EYE_OUTER: 6,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  MOUTH_LEFT: 9,
  MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_PINKY: 17,
  RIGHT_PINKY: 18,
  LEFT_INDEX: 19,
  RIGHT_INDEX: 20,
  LEFT_THUMB: 21,
  RIGHT_THUMB: 22,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
} as const;

/** 骨格の接続定義 [from, to] */
const SKELETON_CONNECTIONS: [number, number][] = [
  // 胴体
  [POSE.LEFT_SHOULDER, POSE.RIGHT_SHOULDER],
  [POSE.LEFT_HIP, POSE.RIGHT_HIP],
  [POSE.LEFT_SHOULDER, POSE.LEFT_HIP],
  [POSE.RIGHT_SHOULDER, POSE.RIGHT_HIP],
  // 左腕
  [POSE.LEFT_SHOULDER, POSE.LEFT_ELBOW],
  [POSE.LEFT_ELBOW, POSE.LEFT_WRIST],
  // 右腕
  [POSE.RIGHT_SHOULDER, POSE.RIGHT_ELBOW],
  [POSE.RIGHT_ELBOW, POSE.RIGHT_WRIST],
  // 左脚
  [POSE.LEFT_HIP, POSE.LEFT_KNEE],
  [POSE.LEFT_KNEE, POSE.LEFT_ANKLE],
  // 右脚
  [POSE.RIGHT_HIP, POSE.RIGHT_KNEE],
  [POSE.RIGHT_KNEE, POSE.RIGHT_ANKLE],
  // 顔周辺（簡略化）
  [POSE.LEFT_SHOULDER, POSE.LEFT_EAR],
  [POSE.RIGHT_SHOULDER, POSE.RIGHT_EAR],
];

/** ポイント描画設定 */
const JOINT_RADIUS = 5;
const LINE_WIDTH = 3;

/** 信頼度に応じた色を取得 */
function getConfidenceColor(visibility: number): string {
  if (visibility > 0.7) return '#00ff88'; // 高信頼度: 緑
  if (visibility > 0.4) return '#ffcc00'; // 中信頼度: 黄
  return '#ff4444'; // 低信頼度: 赤
}

/** ボーン（骨格線）の色 */
function getBoneColor(
  v1: number,
  v2: number,
): string {
  const avg = (v1 + v2) / 2;
  if (avg > 0.7) return 'rgba(0, 255, 136, 0.8)';
  if (avg > 0.4) return 'rgba(255, 204, 0, 0.6)';
  return 'rgba(255, 68, 68, 0.4)';
}

/**
 * Canvas 上にスケルトンを描画する
 */
export function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  width: number,
  height: number,
): void {
  if (landmarks.length < 33) return;

  // 骨格線を描画
  ctx.lineWidth = LINE_WIDTH;
  ctx.lineCap = 'round';

  for (const [fromIdx, toIdx] of SKELETON_CONNECTIONS) {
    const from = landmarks[fromIdx];
    const to = landmarks[toIdx];
    const fromVis = from.visibility ?? 0;
    const toVis = to.visibility ?? 0;

    // 信頼度が低すぎるボーンはスキップ
    if (fromVis < 0.2 || toVis < 0.2) continue;

    const x1 = from.x * width;
    const y1 = from.y * height;
    const x2 = to.x * width;
    const y2 = to.y * height;

    ctx.strokeStyle = getBoneColor(fromVis, toVis);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  // 関節ポイントを描画（上半身中心）
  const importantJoints = [
    POSE.LEFT_SHOULDER, POSE.RIGHT_SHOULDER,
    POSE.LEFT_ELBOW, POSE.RIGHT_ELBOW,
    POSE.LEFT_WRIST, POSE.RIGHT_WRIST,
    POSE.LEFT_HIP, POSE.RIGHT_HIP,
    POSE.LEFT_KNEE, POSE.RIGHT_KNEE,
    POSE.LEFT_ANKLE, POSE.RIGHT_ANKLE,
  ];

  for (const idx of importantJoints) {
    const lm = landmarks[idx];
    const vis = lm.visibility ?? 0;
    if (vis < 0.2) continue;

    const x = lm.x * width;
    const y = lm.y * height;

    ctx.fillStyle = getConfidenceColor(vis);
    ctx.beginPath();
    ctx.arc(x, y, JOINT_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    // 外枠
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // ラインの太さを復元
  ctx.lineWidth = LINE_WIDTH;
}
