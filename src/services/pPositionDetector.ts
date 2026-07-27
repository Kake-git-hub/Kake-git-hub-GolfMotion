import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import { P_POINT_IDS, type PPoint, type PPointId } from '../types/ppoint';
import { POSE } from './skeletonRenderer';

/**
 * P システム (P1〜P10) 自動検出
 *
 * ゴルフ業界標準の 10 ポジション表記を、バッチ解析済みの全フレームランドマークから
 * 推定する純粋ロジック（DOM 非依存・副作用なし）。右打ちゴルファーを前提とする。
 *
 * アルゴリズム概要:
 *   1. 手の中心トレース（左右手首の visibility 加重平均）を算出し、欠損を線形補間
 *   2. 移動平均で平滑化
 *   3. 頑健なアンカー 4 点を先に確定 (P4 トップ → P7 インパクト → P1 アドレス → P10 フィニッシュ)
 *   4. アンカー間で条件探索して中間点 (P2/P3/P5/P6/P8/P9) を決定
 *      条件が見つからない場合はアンカー間の線形補間（中間フレーム）にフォールバック
 *   5. 単調性 (P1 ≤ P2 ≤ ... ≤ P10) を強制
 */

// ===== チューニング定数 =====

/** ランドマークを採用する visibility の下限 */
const VIS_MIN = 0.3;
/** P4（トップ）の探索範囲（全フレームに対する比率） */
const TOP_SEARCH_START_RATIO = 0.05;
const TOP_SEARCH_END_RATIO = 0.75;
/** P7（インパクト）を P4 から何秒以内で探すか */
const IMPACT_SEARCH_SEC = 1.5;
/** P1（アドレス）の「静止」判定閾値（最大速度に対する比率） */
const STILL_SPEED_RATIO = 0.06;
/** 静止と見なすのに必要な継続時間（秒） */
const STILL_MIN_SEC = 0.15;
/** P10（フィニッシュ）の判定閾値（インパクトピーク速度に対する比率） */
const SETTLE_SPEED_RATIO = 0.15;
/** 速度が収束したと見なすのに必要な継続時間（秒） */
const SETTLE_MIN_SEC = 0.2;
/** 平滑化ウィンドウの基準時間（秒）。ダウンスイングは約0.25秒のため、これより広くすると速度ピークが潰れる */
const SMOOTH_SEC = 0.15;
/** fps が不正な場合の既定値 */
const FALLBACK_FPS = 30;

// ===== 汎用ユーティリティ（小さな純関数） =====

/** 有限数かどうか */
function isNum(v: number): boolean {
  return Number.isFinite(v);
}

/** fps を安全な正の値に正規化する */
function normalizeFps(fps: number): number {
  return Number.isFinite(fps) && fps > 0 ? fps : FALLBACK_FPS;
}

/** 値を [0, n-1] に収める（n <= 0 なら 0） */
function clampIndex(i: number, n: number): number {
  if (n <= 0) return 0;
  if (!isNum(i)) return 0;
  return Math.min(n - 1, Math.max(0, Math.round(i)));
}

/** 2 フレームの中間（線形補間フォールバック用） */
function midFrame(a: number, b: number): number {
  return Math.round((a + b) / 2);
}

/** 移動平均（NaN は無視。周囲が全て NaN なら元の値をそのまま返す） */
function movingAvg(arr: number[], window: number): number[] {
  const half = Math.floor(window / 2);
  return arr.map((v, i) => {
    let sum = 0;
    let count = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < arr.length && isNum(arr[j])) {
        sum += arr[j];
        count++;
      }
    }
    return count > 0 ? sum / count : v;
  });
}

/** fps から平滑化ウィンドウ幅（3 以上の奇数）を決める */
function smoothWindow(fps: number): number {
  const w = Math.max(3, Math.round(fps * SMOOTH_SEC));
  return w % 2 === 0 ? w + 1 : w;
}

/**
 * NaN 区間を前後の有効値から線形補間する。
 * 先頭 / 末尾の NaN は最も近い有効値で埋める。有効値が 1 つも無ければそのまま返す。
 */
function interpolateGaps(arr: number[]): number[] {
  const out = arr.slice();
  const n = out.length;

  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (isNum(out[i])) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return out; // 全て無効

  // 端は最近傍で埋める
  for (let i = 0; i < first; i++) out[i] = out[first];
  for (let i = last + 1; i < n; i++) out[i] = out[last];

  // 内部のギャップを線形補間
  let i = first + 1;
  while (i <= last) {
    if (isNum(out[i])) {
      i++;
      continue;
    }
    const gapStart = i;
    let j = i;
    while (j <= last && !isNum(out[j])) j++;
    const a = out[gapStart - 1];
    const b = out[j];
    const span = j - (gapStart - 1);
    for (let k = gapStart; k < j; k++) {
      out[k] = a + ((b - a) * (k - (gapStart - 1))) / span;
    }
    i = j + 1;
  }
  return out;
}

// ===== ランドマーク抽出（小さな純関数） =====

/** ランドマークの visibility（未定義なら 0） */
function vis(lm: NormalizedLandmark | undefined): number {
  return lm ? (lm.visibility ?? 0) : 0;
}

/**
 * 1 フレームの手の中心（左右手首の visibility 加重平均）。
 * 左右とも visibility < VIS_MIN なら null（＝ NaN 扱い）。
 */
function handCenter(frame: NormalizedLandmark[] | null): { x: number; y: number } | null {
  if (!frame) return null;
  const lw = frame[POSE.LEFT_WRIST];
  const rw = frame[POSE.RIGHT_WRIST];
  const lv = vis(lw);
  const rv = vis(rw);
  if (lv < VIS_MIN && rv < VIS_MIN) return null;
  const w = lv + rv;
  if (w <= 0) return null;
  const x = ((lw?.x ?? 0) * lv + (rw?.x ?? 0) * rv) / w;
  const y = ((lw?.y ?? 0) * lv + (rw?.y ?? 0) * rv) / w;
  if (!isNum(x) || !isNum(y)) return null;
  return { x, y };
}

/**
 * 1 フレームの腰の高さ（左右 HIP の Y を visibility 加重平均）。
 * 取得できなければ NaN。
 */
function hipLevel(frame: NormalizedLandmark[] | null): number {
  if (!frame) return NaN;
  const lh = frame[POSE.LEFT_HIP];
  const rh = frame[POSE.RIGHT_HIP];
  const lv = vis(lh);
  const rv = vis(rh);
  if (lv < VIS_MIN && rv < VIS_MIN) return NaN;
  const w = lv + rv;
  if (w <= 0) return NaN;
  const y = ((lh?.y ?? 0) * lv + (rh?.y ?? 0) * rv) / w;
  return isNum(y) ? y : NaN;
}

/**
 * 腕ベクトル（肩 → 手首）の「水平からのズレ」スコア。
 * 0 に近いほど地面と平行。判定不能なら Infinity。
 */
function armHorizontalScore(
  frame: NormalizedLandmark[] | null,
  shoulderIdx: number,
  wristIdx: number,
): number {
  if (!frame) return Infinity;
  const s = frame[shoulderIdx];
  const w = frame[wristIdx];
  if (!s || !w) return Infinity;
  if (vis(s) < VIS_MIN || vis(w) < VIS_MIN) return Infinity;
  const dx = w.x - s.x;
  const dy = w.y - s.y;
  const len = Math.hypot(dx, dy);
  if (!isNum(len) || len < 1e-6) return Infinity;
  return Math.abs(dy) / len; // = |sin(仰角)|
}

// ===== トレース構築 =====

interface Traces {
  /** 平滑化済み手中心 X */
  handX: number[];
  /** 平滑化済み手中心 Y（0 = 画面上端） */
  handY: number[];
  /** 腰の高さ Y（取得できないフレームは NaN のまま残る場合がある） */
  hipY: number[];
  /** 手の総合速度 |d(x,y)/dt|（正規化座標/秒） */
  speed: number[];
  /** 手の水平速度 |dx/dt| */
  speedX: number[];
  /** 手のトレースが 1 フレームでも取得できたか */
  valid: boolean;
}

/** 全フレームから手・腰・速度のトレースを作る */
function buildTraces(frames: (NormalizedLandmark[] | null)[], fps: number): Traces {
  const n = frames.length;
  const rawX = new Array<number>(n).fill(NaN);
  const rawY = new Array<number>(n).fill(NaN);
  const rawHip = new Array<number>(n).fill(NaN);

  for (let i = 0; i < n; i++) {
    const h = handCenter(frames[i]);
    if (h) {
      rawX[i] = h.x;
      rawY[i] = h.y;
    }
    rawHip[i] = hipLevel(frames[i]);
  }

  const valid = rawX.some(isNum) && rawY.some(isNum);
  const win = smoothWindow(fps);
  const handX = movingAvg(interpolateGaps(rawX), win);
  const handY = movingAvg(interpolateGaps(rawY), win);
  const hipY = movingAvg(interpolateGaps(rawHip), win);

  const speed = new Array<number>(n).fill(0);
  const speedX = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const dx = handX[i] - handX[i - 1];
    const dy = handY[i] - handY[i - 1];
    speedX[i] = isNum(dx) ? Math.abs(dx) * fps : 0;
    speed[i] = isNum(dx) && isNum(dy) ? Math.hypot(dx, dy) * fps : 0;
  }

  return {
    handX,
    handY,
    hipY,
    speed: movingAvg(speed, 3),
    speedX: movingAvg(speedX, 3),
    valid,
  };
}

// ===== アンカー検出 =====

/** 手の速度が最大のフレーム（必ずダウンスイング〜インパクト付近にある） */
function argmaxSpeed(speed: number[], n: number): number {
  let best = 0;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    if (speed[i] > max) {
      max = speed[i];
      best = i;
    }
  }
  return best;
}

/**
 * P4: 速度最大点（ダウンスイング付近）の直前で手 Y が最小（＝最も高い）フレーム。
 *
 * 「動画全体の手 Y 最小 = トップ」とすると、フォロースルーで両腕が頭上に
 * 伸び切った瞬間の方がトップより手が高くなりフォローを誤検出するため、
 * 必ず速度ピークより前の範囲に限定して探索する。
 */
function detectTop(handY: number[], speedPeakIdx: number, n: number, fps: number): number {
  const start = Math.max(0, speedPeakIdx - Math.round(fps * IMPACT_SEARCH_SEC));
  const end = Math.max(start + 1, speedPeakIdx - Math.max(1, Math.round(fps * 0.05)));
  let best = -1;
  let min = Infinity;
  for (let i = start; i < end; i++) {
    if (isNum(handY[i]) && handY[i] < min) {
      min = handY[i];
      best = i;
    }
  }
  if (best >= 0) return best;

  // フォールバック: 全体の 5%〜75% 範囲で手 Y 最小
  const s2 = clampIndex(Math.floor(n * TOP_SEARCH_START_RATIO), n);
  const e2 = Math.max(s2 + 1, Math.min(n, Math.floor(n * TOP_SEARCH_END_RATIO)));
  let best2 = s2;
  let min2 = Infinity;
  for (let i = s2; i < e2; i++) {
    if (isNum(handY[i]) && handY[i] < min2) {
      min2 = handY[i];
      best2 = i;
    }
  }
  return best2;
}

/**
 * P7: P4 以降 fps*1.5 フレーム以内で水平速度 |dx/dt| が最大のフレーム。
 *
 * トップ付近では両手が頭部と重なり手首ランドマークの左右取り違えによる
 * 偽の速度スパイクが出やすいため、「手がトップ高さとアドレス高さの
 * 中間より下まで降りてから」の速度ピークのみをインパクト候補とする。
 */
function detectImpact(speedX: number[], handY: number[], topIdx: number, n: number, fps: number): number {
  // 切り返し直後の誤検出を防ぐため最低 0.1 秒はダウンスイングに割り当てる
  const start = Math.min(topIdx + Math.max(1, Math.round(fps * 0.1)), n - 1);
  const end = Math.max(start + 1, Math.min(n, topIdx + Math.round(fps * IMPACT_SEARCH_SEC) + 1));

  // 高さゲート: トップの手の高さとアドレス側の手の高さの 60% 地点
  const topY = handY[topIdx];
  let addrY = -Infinity;
  for (let i = 0; i < topIdx; i++) {
    if (isNum(handY[i]) && handY[i] > addrY) addrY = handY[i];
  }
  const gate = isNum(topY) && isNum(addrY) && addrY > topY
    ? topY + (addrY - topY) * 0.6
    : -Infinity;

  let best = -1;
  let max = -Infinity;
  for (let i = start; i < end; i++) {
    if (isNum(handY[i]) && handY[i] < gate) continue; // まだ手が高い位置（ダウンスイング前半）は除外
    if (speedX[i] > max) {
      max = speedX[i];
      best = i;
    }
  }
  if (best >= 0) return best;

  // フォールバック: ゲートなしの速度ピーク
  let best2 = start;
  let max2 = -Infinity;
  for (let i = start; i < end; i++) {
    if (speedX[i] > max2) {
      max2 = speedX[i];
      best2 = i;
    }
  }
  return best2;
}

/**
 * P1: P4 より前で、フレーム間変位が閾値未満の「静止」が続いた最後のフレーム。
 * 見つからなければ 0。
 */
function detectAddress(speed: number[], topIdx: number, fps: number): number {
  if (topIdx <= 0) return 0;
  let peak = 0;
  for (const s of speed) if (s > peak) peak = s;
  const thresh = Math.max(peak * STILL_SPEED_RATIO, 1e-4);
  const minRun = Math.max(2, Math.round(fps * STILL_MIN_SEC));

  let run = 0;
  let last = -1;
  for (let i = 0; i < topIdx; i++) {
    if (speed[i] < thresh) {
      run++;
      if (run >= minRun) last = i;
    } else {
      run = 0;
    }
  }
  return last >= 0 ? last : 0;
}

/**
 * P10: P7 以降で速度がインパクトピークの 15% 未満に一定フレーム数落ち着いた最初のフレーム。
 * 見つからなければ最終フレーム。
 */
function detectFinish(speed: number[], impactIdx: number, n: number, fps: number): number {
  let peak = 0;
  for (let i = Math.max(0, impactIdx - 2); i <= Math.min(n - 1, impactIdx + 2); i++) {
    if (speed[i] > peak) peak = speed[i];
  }
  if (peak <= 0) return n - 1;

  const thresh = peak * SETTLE_SPEED_RATIO;
  const minRun = Math.max(2, Math.round(fps * SETTLE_MIN_SEC));
  let run = 0;
  for (let i = impactIdx + 1; i < n; i++) {
    if (speed[i] < thresh) {
      run++;
      if (run >= minRun) return i;
    } else {
      run = 0;
    }
  }
  return n - 1;
}

// ===== 中間点検出 =====

/**
 * 指定区間 [from, to] で腕ベクトルが最も水平に近いフレームを返す。
 * 判定できるフレームが 1 つも無ければ -1。
 */
function findMostHorizontalArm(
  frames: (NormalizedLandmark[] | null)[],
  from: number,
  to: number,
  shoulderIdx: number,
  wristIdx: number,
): number {
  const n = frames.length;
  const lo = clampIndex(Math.min(from, to), n);
  const hi = clampIndex(Math.max(from, to), n);
  let best = -1;
  let min = Infinity;
  for (let i = lo; i <= hi; i++) {
    const score = armHorizontalScore(frames[i], shoulderIdx, wristIdx);
    if (score < min) {
      min = score;
      best = i;
    }
  }
  return best;
}

/** 腰の高さの通過方向 */
type CrossDir = 'up' | 'down';

/**
 * 指定区間 [from, to] で手 Y が腰の高さを通過する最初のフレームを返す。
 * @param dir 'up' = 下から上（手 Y が減少して腰より上へ）/ 'down' = 上から下
 * @returns 通過フレーム。見つからなければ -1
 */
function findHipCross(
  handY: number[],
  hipY: number[],
  from: number,
  to: number,
  dir: CrossDir,
): number {
  const n = handY.length;
  const lo = clampIndex(Math.min(from, to), n);
  const hi = clampIndex(Math.max(from, to), n);
  for (let i = Math.max(lo + 1, 1); i <= hi; i++) {
    const prev = handY[i - 1] - hipY[i - 1];
    const cur = handY[i] - hipY[i];
    if (!isNum(prev) || !isNum(cur)) continue;
    // 正 = 手が腰より下 / 負 = 手が腰より上
    if (dir === 'up' && prev >= 0 && cur < 0) return i;
    if (dir === 'down' && prev <= 0 && cur > 0) return i;
  }
  return -1;
}

// ===== 出力整形 =====

/** PPoint を組み立てる */
function makePPoint(id: PPointId, frameIndex: number, fps: number): PPoint {
  return { id, frameIndex, timeSec: frameIndex / fps };
}

/** フレーム番号配列を PPoint[] に変換する */
function toPPoints(indices: number[], fps: number): PPoint[] {
  return P_POINT_IDS.map((id, i) => makePPoint(id, indices[i] ?? 0, fps));
}

/** [0, n-1] クランプ + 単調非減少を強制する（前から順に clamp） */
function enforceMonotonic(indices: number[], n: number): number[] {
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < indices.length; i++) {
    let v = clampIndex(indices[i], n);
    if (i > 0 && v < prev) v = prev;
    out.push(v);
    prev = v;
  }
  return out;
}

/** 全体を等間隔に割った 10 点（エッジケース用フォールバック） */
function evenlySpaced(n: number, fps: number): PPoint[] {
  const last = P_POINT_IDS.length - 1;
  return P_POINT_IDS.map((id, i) =>
    makePPoint(id, n <= 1 ? 0 : Math.round((i * (n - 1)) / last), fps),
  );
}

// ===== 公開 API =====

/**
 * 全フレームのランドマークから P1〜P10 の位置を検出する。
 *
 * 例外は投げない。フレーム数が少ない / ランドマークが全て取得できない場合は
 * 全体を等間隔に割った 10 点を返す。
 *
 * @param frames バッチ解析結果 (index=フレーム番号, 検出失敗フレームは null)
 * @param fps バッチ解析FPS
 * @returns 必ず10要素 (P1..P10順)。frameIndex は単調非減少。timeSec = frameIndex / fps
 */
export function detectPPoints(frames: (NormalizedLandmark[] | null)[], fps: number): PPoint[] {
  const safeFps = normalizeFps(fps);
  const n = Array.isArray(frames) ? frames.length : 0;

  // --- エッジケース: フレーム不足 ---
  if (n < 10) return evenlySpaced(n, safeFps);

  const tr = buildTraces(frames, safeFps);

  // --- エッジケース: 手のトレースが全く取れない（全 null など） ---
  if (!tr.valid) return evenlySpaced(n, safeFps);

  // --- ステップ3: アンカー 4 点 ---
  // 速度ピーク（ダウンスイング〜インパクト付近）を先に求め、トップはその直前から探す
  const speedPeakIdx = argmaxSpeed(tr.speed, n);
  const p4 = detectTop(tr.handY, speedPeakIdx, n, safeFps);
  const p7 = detectImpact(tr.speedX, tr.handY, p4, n, safeFps);
  const p1 = detectAddress(tr.speed, p4, safeFps);
  const p10 = detectFinish(tr.speed, p7, n, safeFps);

  // --- ステップ4: 中間点（見つからなければアンカー間の中間フレームへフォールバック） ---

  // P3: P1..P4 で左腕が最も水平
  const p3Found = findMostHorizontalArm(frames, p1, p4, POSE.LEFT_SHOULDER, POSE.LEFT_WRIST);
  const p3 = p3Found >= 0 ? p3Found : midFrame(p1, p4);

  // P2: P1..P3 で手 Y が腰の高さを下 → 上に通過
  const p2Found = findHipCross(tr.handY, tr.hipY, p1, p3, 'up');
  const p2 = p2Found >= 0 ? p2Found : midFrame(p1, p3);

  // P5: P4..P7 で左腕が最も水平
  const p5Found = findMostHorizontalArm(frames, p4, p7, POSE.LEFT_SHOULDER, POSE.LEFT_WRIST);
  const p5 = p5Found >= 0 ? p5Found : midFrame(p4, p7);

  // P6: P5..P7 で手 Y が腰の高さを上 → 下に通過（ダウンスイング）
  const p6Found = findHipCross(tr.handY, tr.hipY, p5, p7, 'down');
  const p6 = p6Found >= 0 ? p6Found : midFrame(p5, p7);

  // P8: P7..P10 で手 Y が腰の高さを下 → 上に通過（フォロー）
  //     見つからない場合は P7 と暫定 P9 の中間
  const p8Found = findHipCross(tr.handY, tr.hipY, p7, p10, 'up');
  let p8: number;
  if (p8Found >= 0) {
    p8 = p8Found;
  } else {
    const p9Prov = findMostHorizontalArm(frames, p7, p10, POSE.RIGHT_SHOULDER, POSE.RIGHT_WRIST);
    p8 = midFrame(p7, p9Prov >= 0 ? p9Prov : p10);
  }

  // P9: P8..P10 で右腕が最も水平
  const p9Found = findMostHorizontalArm(frames, p8, p10, POSE.RIGHT_SHOULDER, POSE.RIGHT_WRIST);
  const p9 = p9Found >= 0 ? p9Found : midFrame(p8, p10);

  // --- ステップ5: 単調性の強制 ---
  const indices = enforceMonotonic([p1, p2, p3, p4, p5, p6, p7, p8, p9, p10], n);

  return toPPoints(indices, safeFps);
}
