import {
  PoseLandmarker,
  FilesetResolver,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision';

export type PoseLandmarks = NormalizedLandmark[];

export interface PoseResult {
  landmarks: PoseLandmarks;
  worldLandmarks: NormalizedLandmark[];
}

let poseLandmarker: PoseLandmarker | null = null;
let lastTimestamp = -1;

/**
 * MediaPipe PoseLandmarker を初期化する
 * heavy モデルを使用し、GPU デリゲートで実行
 */
export async function initPoseDetector(): Promise<void> {
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm',
  );

  poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task',
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numPoses: 1,
  });
}

/**
 * ビデオフレームからポーズランドマークを検出する
 * 33 点の正規化座標 (0~1) を返す
 */
export function detectPose(
  video: HTMLVideoElement,
): PoseResult | null {
  if (!poseLandmarker) return null;

  // MediaPipe はタイムスタンプが厳密に単調増加である必要がある
  const timestamp = performance.now();
  if (timestamp <= lastTimestamp) return null;
  lastTimestamp = timestamp;

  const result = poseLandmarker.detectForVideo(video, timestamp);
  if (!result.landmarks || result.landmarks.length === 0) return null;

  return {
    landmarks: result.landmarks[0],
    worldLandmarks: result.worldLandmarks?.[0] ?? [],
  };
}

/**
 * クリーンアップ
 */
export function disposePoseDetector(): void {
  poseLandmarker?.close();
  poseLandmarker = null;
  lastTimestamp = -1;
}

/**
 * 初期化済みかどうか
 */
export function isPoseDetectorReady(): boolean {
  return poseLandmarker !== null;
}
