/**
 * 動画フレーム切り出しユーティリティ
 *
 * HTMLVideoElement から指定時刻のフレームを JPEG dataURL として取り出す。
 * P 点ギャラリー (PPointGallery) のサムネイル生成に使う。
 *
 * 注意: シークは非同期なので必ず seekAndWait で 'seeked' を待ってから描画すること。
 *       ブラウザによっては 'seeked' が発火しないケースがあるため、必ず timeout で解決する。
 */

/** サムネイルの既定最大幅 (px) */
const DEFAULT_MAX_WIDTH = 480;
/** シーク待ちの既定タイムアウト (ms) */
const DEFAULT_SEEK_TIMEOUT_MS = 1000;
/** 「既に同時刻」と見なす許容誤差 (秒) = ±1ms */
const SEEK_EPSILON = 0.001;
/** JPEG 品質 */
const JPEG_QUALITY = 0.85;

/** 縮小用キャンバス（モジュールレベルで再利用してGC負荷を抑える） */
let sharedCanvas: HTMLCanvasElement | null = null;
let sharedCtx: CanvasRenderingContext2D | null = null;

/**
 * 再利用キャンバスを指定サイズで取得する。
 * 取得できない環境（SSR など）では null。
 */
function acquireCanvas(
  width: number,
  height: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null;

  if (!sharedCanvas) {
    sharedCanvas = document.createElement('canvas');
    sharedCtx = sharedCanvas.getContext('2d');
  }
  const canvas = sharedCanvas;
  const ctx = sharedCtx;
  if (!canvas || !ctx) return null;

  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return { canvas, ctx };
}

/** シーク先の時刻を [0, duration] に収める */
function clampTime(video: HTMLVideoElement, timeSec: number): number {
  const t = Number.isFinite(timeSec) ? timeSec : 0;
  const duration = video.duration;
  const upper = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  return Math.min(Math.max(t, 0), upper);
}

/**
 * 堅牢なシーク: currentTime を設定して 'seeked' イベントを待つ。
 *
 * - 目標時刻は [0, duration] にクランプする
 * - 既に同時刻 (±1ms) なら即 resolve
 * - 'seeked' が来なくても timeoutMs で必ず解決する（reject しない）
 *
 * @param video 対象の video 要素
 * @param timeSec シーク先の時刻 (秒)
 * @param timeoutMs タイムアウト (既定 1000ms)
 */
export function seekAndWait(
  video: HTMLVideoElement,
  timeSec: number,
  timeoutMs = DEFAULT_SEEK_TIMEOUT_MS,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const target = clampTime(video, timeSec);

    // 既に目標時刻ならシーク不要
    if (Math.abs(video.currentTime - target) <= SEEK_EPSILON) {
      resolve();
      return;
    }

    let settled = false;
    let timer = 0;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', finish);
      if (timer) window.clearTimeout(timer);
      resolve();
    };
    const onSeeked = (): void => finish();

    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', finish);
    timer = window.setTimeout(finish, timeoutMs);

    try {
      video.currentTime = target;
    } catch {
      // currentTime 設定に失敗（未ロードなど）→ 待たずに解決
      finish();
    }
  });
}

/**
 * 現在表示中のフレームを JPEG dataURL として取得する。
 *
 * maxWidth を超える動画はアスペクト比を維持して縮小する。
 *
 * @param video 対象の video 要素
 * @param maxWidth 出力の最大幅 (既定 480)
 * @returns dataURL。drawImage / toDataURL に失敗したら null
 */
export function captureCurrentFrame(
  video: HTMLVideoElement,
  maxWidth = DEFAULT_MAX_WIDTH,
): string | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  const limit = maxWidth > 0 ? maxWidth : DEFAULT_MAX_WIDTH;
  const scale = vw > limit ? limit / vw : 1;
  const w = Math.max(1, Math.round(vw * scale));
  const h = Math.max(1, Math.round(vh * scale));

  const target = acquireCanvas(w, h);
  if (!target) return null;

  try {
    target.ctx.drawImage(video, 0, 0, w, h);
    return target.canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  } catch {
    // CORS 汚染キャンバス / 未描画などで失敗する
    return null;
  }
}

/**
 * 単一時刻のフレームを切り出す。
 *
 * この関数はシークする。元の再生位置は復元しない（呼び出し側の責務）。
 *
 * @param video 対象の video 要素
 * @param timeSec 切り出す時刻 (秒)
 * @param maxWidth 出力の最大幅 (既定 480)
 */
export async function extractFrameAt(
  video: HTMLVideoElement,
  timeSec: number,
  maxWidth = DEFAULT_MAX_WIDTH,
): Promise<string | null> {
  await seekAndWait(video, timeSec);
  return captureCurrentFrame(video, maxWidth);
}

/**
 * 複数時刻のフレームを順次切り出す。
 *
 * シーク中の乱れを避けるため一時的に一時停止し、完了後に
 * 動画の currentTime を開始前の位置に復元する（再生中だった場合は再生も再開）。
 *
 * @param video 対象の video 要素
 * @param times 切り出す時刻の配列 (秒)
 * @param onProgress 進捗コールバック (done, total)
 * @param maxWidth 出力の最大幅 (既定 480)
 * @returns times と同じ長さの dataURL 配列（失敗した要素は null）
 */
export async function extractFramesAt(
  video: HTMLVideoElement,
  times: number[],
  onProgress?: (done: number, total: number) => void,
  maxWidth = DEFAULT_MAX_WIDTH,
): Promise<(string | null)[]> {
  const total = times.length;
  const results: (string | null)[] = [];

  if (total === 0) {
    onProgress?.(0, 0);
    return results;
  }

  const originalTime = video.currentTime;
  const wasPlaying = !video.paused;
  if (wasPlaying) video.pause();

  try {
    for (let i = 0; i < total; i++) {
      results.push(await extractFrameAt(video, times[i], maxWidth));
      onProgress?.(i + 1, total);
    }
  } finally {
    // 開始前の再生位置に復元
    await seekAndWait(video, originalTime);
    if (wasPlaying) {
      void video.play().catch(() => { /* 自動再生がブロックされても無視 */ });
    }
  }

  return results;
}
