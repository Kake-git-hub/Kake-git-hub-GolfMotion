import { useState, useRef, useCallback, useEffect } from 'react';
import VideoUploader from './components/VideoUploader';
import VideoPlayer, { type VideoPlayerHandle } from './components/VideoPlayer';
import SkeletonCanvas, { type SkeletonCanvasHandle } from './components/SkeletonCanvas';
import PPointFilmstrip, { type FilmstripThumb } from './components/PPointFilmstrip';
import ClubManager from './components/ClubManager';
import RecordHistory from './components/RecordHistory';
import DataSync from './components/DataSync';
import { initPoseDetector, detectPose, disposePoseDetector, isPoseDetectorReady, type PoseResult } from './services/poseDetector';
import { drawSkeleton } from './services/skeletonRenderer';
import { calculateAngles, drawAngles } from './services/angleCalculator';
import { drawGrid } from './services/gridRenderer';
import { LandmarkSmoother } from './services/landmarkSmoother';
import { ConfidenceInterpolator } from './services/confidenceInterpolator';
import { detectPPoints, estimateSwingWindow, refinePPoints } from './services/pPositionDetector';
import { extractFramesAt, captureThumbnail, seekAndWait } from './services/frameExtractor';
import { getMainSet } from './services/clubSetStore';
import { saveRecord } from './services/recordStore';
import { useTouchGestures } from './hooks/useTouchGestures';
import { P_POINT_IDS, P_POINT_INFO, clampPPointTime, type PPoint, type PPointId } from './types/ppoint';
import type { Club } from './types/club';
import { ANGLE_LABEL_TO_KEY, type FrameAngles, type SwingRecord } from './types/record';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import './App.css';

type AppState = 'idle' | 'loading-model' | 'ready' | 'batch-analyzing' | 'error';
type AppView = 'analysis' | 'clubs' | 'history' | 'data';
/** バッチ解析の3段階: 粗いスキャン → 窓内本解析 → 高速区間の精密化 */
type BatchStage = 'scan' | 'pose' | 'refine';

/** 粗いスキャンの目標 FPS（スイング区間の大まかな検出用） */
const COARSE_FPS = 5;
/** 粗いスキャンの最大フレーム数（長尺動画でも安全に収める） */
const MAX_COARSE_FRAMES = 200;
/** 本解析の目標 FPS（ダウンスイングは約0.25秒しかないため 20fps） */
const ANALYSIS_FPS = 20;
/** スイング区間推定の前後に足すパディング（秒） */
const WINDOW_PAD_SEC = 1;
/** 本解析窓の最大フレーム数（安全弁） */
const MAX_WINDOW_FRAMES = 400;
/**
 * 高速区間（P3〜P8）の再サンプリング FPS。
 * この区間はスイングが最も速く、20fps では 1 コマ 0.05 秒あって
 * 隣り合う P 点が同じコマに乗ってしまうため、集中的に細かく撮り直す。
 */
const FAST_FPS = 60;
/** 高速区間の前後に足す余白（秒）。局所再探索がはみ出さないよう確保する */
const FAST_PAD_SEC = 0.15;
/** 高速区間の最大フレーム数（安全弁） */
const MAX_FAST_FRAMES = 240;
/**
 * 高 fps サンプルで位置を精密化する P 点。
 *
 * P3/P5(腕が水平)・P4(手の最高点)・P7(水平速度のピーク) は基準が鋭いので
 * コマを細かくするほど正確になる。
 * 一方 P6/P8(シャフトが水平) はクラブを検出できないため「手が腰の高さ」で
 * 代用しており、その通過はインパクト直後にも起こる。精密化すると P7 に
 * 吸い寄せられて重なってしまうため、粗い位置のまま据え置く。
 */
const FAST_REFINE_IDS: PPointId[] = ['P3', 'P4', 'P5', 'P7'];
/** フィルムストリップに並べるコマ数の上限 */
const MAX_THUMBS = 30;
/**
 * 各解析ステージでコマ画像を撮る枚数の目安。
 * JPEG 変換は 1 枚ずつは軽くても数百枚だと効いてくるので、
 * 帯に並べるのに十分な候補数だけ撮って解析を速く保つ。
 */
const THUMB_CANDIDATES = 40;
/**
 * コマ帯の表示範囲を P1〜P10 の前後に足す余白（P1..P10 の長さに対する比率）。
 * 解析ウィンドウは検出を安定させるため広めに取るが、帯はスイングそのものに
 * 密着させないとコマが粗くなり P 点も一箇所に固まって見えるため、別に持つ。
 */
const STRIP_PAD_RATIO = 0.12;
/** コマ帯の前後余白の最小値（秒） */
const STRIP_PAD_MIN_SEC = 0.2;
/** ドラッグ何 px で 1 フレーム送り */
const PX_PER_FRAME = 30;
/** 使用クラブ選択の保存キー */
const SELECTED_CLUB_KEY = 'golf-motion.selectedClub';

/**
 * ランドマークから記録用の関節角度を取り出す。
 * angleCalculator は日本語ラベル付きで返すので、グラフ用のキーに変換する。
 */
function anglesFor(landmarks: NormalizedLandmark[] | null): FrameAngles | undefined {
  if (!landmarks || landmarks.length === 0) return undefined;
  const out: FrameAngles = {};
  for (const info of calculateAngles(landmarks)) {
    const key = ANGLE_LABEL_TO_KEY[info.label];
    if (key && Number.isFinite(info.angle)) out[key] = info.angle;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * コマ画像の集合から、指定範囲を時間的に等間隔で覆う最大 count 枚を選ぶ。
 *
 * 本解析(20fps)と高速区間(60fps)でコマの密度が違うため、インデックスではなく
 * 時刻を基準に「その位置に最も近いコマ」を拾う。
 */
function pickEvenlySpacedThumbs(
  all: FilmstripThumb[],
  start: number,
  end: number,
  count: number,
): FilmstripThumb[] {
  const inRange = all
    .filter(t => t.timeSec >= start - 1e-6 && t.timeSec <= end + 1e-6)
    .sort((a, b) => a.timeSec - b.timeSec);
  if (inRange.length <= count) return inRange;

  const picked: FilmstripThumb[] = [];
  let lastIdx = -1;
  for (let k = 0; k < count; k++) {
    const target = count === 1 ? start : start + ((end - start) * k) / (count - 1);
    let bestIdx = 0;
    let bestD = Infinity;
    for (let i = 0; i < inRange.length; i++) {
      const d = Math.abs(inRange[i].timeSec - target);
      if (d < bestD) {
        bestD = d;
        bestIdx = i;
      }
    }
    if (bestIdx !== lastIdx) {
      picked.push(inRange[bestIdx]);
      lastIdx = bestIdx;
    }
  }
  return picked;
}

export default function App() {
  const [state, setState] = useState<AppState>('idle');
  const [view, setView] = useState<AppView>('analysis');
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [showSkeleton, setShowSkeleton] = useState(true);
  const [showAngles, setShowAngles] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [videoDims, setVideoDims] = useState({ width: 640, height: 480 });
  const [currentTime, setCurrentTime] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  /** 表示オプション（骨格/角度/グリッド/回転）パネルの開閉。既定は閉じてUIをすっきりさせる */
  const [showViewOptions, setShowViewOptions] = useState(false);
  const [batchStage, setBatchStage] = useState<BatchStage>('scan');

  // P システム
  const [pPoints, setPPoints] = useState<PPoint[]>([]);
  /** フィルムストリップに並べるスイング区間のコマ */
  const [thumbs, setThumbs] = useState<FilmstripThumb[]>([]);
  /** フィルムストリップが表す時間範囲（＝スイング区間。動画全体ではない） */
  const [swingWindow, setSwingWindow] = useState({ start: 0, end: 0 });
  /** 編集対象として選択中の P 点（null = 未選択） */
  const [selectedPId, setSelectedPId] = useState<PPointId | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');

  // クラブ
  const [clubs, setClubs] = useState<Club[]>([]);
  const [selectedClubId, setSelectedClubId] = useState<string>(
    () => localStorage.getItem(SELECTED_CLUB_KEY) ?? '',
  );

  const playerRef = useRef<VideoPlayerHandle>(null);
  const canvasRef = useRef<SkeletonCanvasHandle>(null);
  const gridCanvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  /**
   * 進捗表示は state ではなく DOM を直接書き換える。
   * 解析ループは 200 フレーム前後回るため、フレームごとに再描画すると
   * 描画コストが解析本体を上回ってしまう。
   */
  const progressFillRef = useRef<HTMLDivElement>(null);
  const progressTextRef = useRef<HTMLSpanElement>(null);

  const reportProgress = useCallback((pct: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    if (progressFillRef.current) progressFillRef.current.style.width = `${clamped}%`;
    if (progressTextRef.current) progressTextRef.current.textContent = `${clamped}%`;
  }, []);

  // 解析パイプライン
  const smootherRef = useRef(new LandmarkSmoother(1.7, 0.01));
  const interpolatorRef = useRef(new ConfidenceInterpolator(3));

  // 窓内フレーム解析結果キャッシュ（index はウィンドウ先頭からの相対フレーム番号）
  const allFramesRef = useRef<(NormalizedLandmark[] | null)[]>([]);
  /** 解析ウィンドウの絶対開始/終了時刻（秒） */
  const windowStartRef = useRef(0);
  const windowEndRef = useRef(0);
  const cachedPoseRef = useRef<PoseResult | null>(null);
  /** 実際に使用した本解析 FPS */
  const analysisFpsRef = useRef(ANALYSIS_FPS);
  /** 高速区間の高 fps サンプル（P3〜P8 付近。スクラブ時もこちらを優先して引く） */
  const fastFramesRef = useRef<(NormalizedLandmark[] | null)[]>([]);
  const fastStartRef = useRef(0);
  const fastFpsRef = useRef(FAST_FPS);
  const pPointsRef = useRef<PPoint[]>([]);
  const selectedPIdRef = useRef<PPointId | null>(null);
  /** 一括処理中は seeked ハンドラの再解析を抑止する */
  const suppressSeekRef = useRef(false);

  // ドラッグ時の基準時刻
  const dragBaseTimeRef = useRef(0);

  // ---------- 窓内キャッシュからランドマークを引く（ライブ推論を避けて遅延を防ぐ） ----------
  const lookupCachedLandmarks = useCallback((timeSec: number): NormalizedLandmark[] | null => {
    // 高速区間は 60fps サンプルの方が正確なので優先して引く
    const fast = fastFramesRef.current;
    if (fast.length > 0) {
      const fFps = fastFpsRef.current;
      const fStart = fastStartRef.current;
      const fEnd = fStart + (fast.length - 1) / fFps;
      if (timeSec >= fStart && timeSec <= fEnd) {
        const idx = Math.round((timeSec - fStart) * fFps);
        const hit = fast[Math.max(0, Math.min(fast.length - 1, idx))];
        if (hit) return hit;
      }
    }

    const frames = allFramesRef.current;
    if (frames.length === 0) return null;
    const fps = analysisFpsRef.current;
    const buffer = 1 / Math.max(fps, 1);
    if (timeSec < windowStartRef.current - buffer || timeSec > windowEndRef.current + buffer) {
      return null; // 解析ウィンドウ外 → キャッシュなし（呼び出し側でライブ推論にフォールバック）
    }
    const idx = Math.round((timeSec - windowStartRef.current) * fps);
    const clamped = Math.max(0, Math.min(frames.length - 1, idx));
    return frames[clamped] ?? null;
  }, []);

  // ---------- drawFrame ----------
  const drawFrame = useCallback((poseResult: PoseResult | null, pLabel?: PPointId | null) => {
    const ctx = canvasRef.current?.getContext();
    if (!ctx) return;
    const { width, height } = videoDims;
    ctx.clearRect(0, 0, width, height);

    if (poseResult) {
      const ts = performance.now() / 1000;
      const smoothed = smootherRef.current.smooth(poseResult.landmarks, ts);
      interpolatorRef.current.push(smoothed);
      const final = interpolatorRef.current.getCurrent() ?? smoothed;

      if (showSkeleton) drawSkeleton(ctx, final, width, height);
      if (showAngles) {
        const angles = calculateAngles(final);
        drawAngles(ctx, angles, width, height);
      }
    }

    if (pLabel) {
      const info = P_POINT_INFO[pLabel];
      const text = info.label;
      ctx.font = 'bold 16px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const metrics = ctx.measureText(text);
      const padX = 10;
      const padY = 6;
      const bgW = metrics.width + padX * 2;
      const bgH = 20 + padY * 2;
      const cx = width / 2;
      const cy = 10;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.beginPath();
      ctx.roundRect(cx - bgW / 2, cy, bgW, bgH, 6);
      ctx.fill();
      ctx.fillStyle = info.color;
      ctx.fillText(text, cx, cy + padY);
    }
  }, [videoDims, showSkeleton, showAngles]);

  // ---------- Grid overlay ----------
  const drawGridOverlay = useCallback(() => {
    const canvas = gridCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.clearRect(0, 0, w, h);
    if (showGrid) drawGrid(ctx, w, h);
  }, [showGrid]);

  // ---------- Model ----------
  const loadModel = useCallback(async () => {
    if (isPoseDetectorReady()) return;
    setState('loading-model');
    try {
      await initPoseDetector();
      setState('ready');
    } catch (err) {
      console.error('Model loading failed:', err);
      setErrorMsg('ポーズ検出モデルの読み込みに失敗しました。');
      setState('error');
    }
  }, []);

  // ---------- 2段階バッチ解析: 粗いスキャン → スイング窓の推定 → 窓内のみ本解析 ----------
  const batchAnalyze = useCallback(async () => {
    const video = playerRef.current?.getVideoElement();
    if (!video || !isPoseDetectorReady()) return;

    setState('batch-analyzing');
    const dur = video.duration;


    suppressSeekRef.current = true;
    try {
      // --- ステージ1: 粗いスキャンでスイング区間を推定 ---
      setBatchStage('scan');
      reportProgress(0);
      const coarseFps = Math.min(COARSE_FPS, Math.max(1, MAX_COARSE_FRAMES / Math.max(dur, 0.1)));
      const coarseStep = 1 / coarseFps;
      const coarseTotal = Math.max(1, Math.floor(dur * coarseFps));
      const coarseFrames: (NormalizedLandmark[] | null)[] = [];

      for (let i = 0; i <= coarseTotal; i++) {
        const t = Math.min(i * coarseStep, dur);
        await seekAndWait(video, t);
        const result = detectPose(video);
        coarseFrames.push(result?.landmarks ?? null);
        reportProgress(Math.round((i / coarseTotal) * 100));
      }

      const estimate = estimateSwingWindow(coarseFrames, coarseFps);
      const windowStart = Math.max(0, estimate.startSec - WINDOW_PAD_SEC);
      const windowEnd = Math.min(dur, estimate.endSec + WINDOW_PAD_SEC);
      windowStartRef.current = windowStart;
      windowEndRef.current = windowEnd;
      setSwingWindow({ start: windowStart, end: windowEnd });

      // --- ステージ2: 窓内のみ 20fps で本解析（処理を軽くする） ---
      setBatchStage('pose');
      reportProgress(0);
      const windowDur = Math.max(windowEnd - windowStart, 0.1);
      const fps = Math.min(ANALYSIS_FPS, Math.max(1, MAX_WINDOW_FRAMES / windowDur));
      analysisFpsRef.current = fps;
      const step = 1 / fps;
      const totalFrames = Math.max(1, Math.floor(windowDur * fps));
      const frames: (NormalizedLandmark[] | null)[] = [];

      // 既にシーク済みの位置でコマ画像も拾う（追加シークが要らないので安い）。
      // ただし JPEG 変換はそれなりに重いので、帯に必要な枚数だけ間引いて撮る。
      const collected: FilmstripThumb[] = [];
      const thumbStride = Math.max(1, Math.ceil((totalFrames + 1) / THUMB_CANDIDATES));

      for (let i = 0; i <= totalFrames; i++) {
        const t = Math.min(windowStart + i * step, windowEnd);
        await seekAndWait(video, t);
        const result = detectPose(video);
        frames.push(result?.landmarks ?? null);
        if (i % thumbStride === 0) {
          const url = captureThumbnail(video);
          if (url) collected.push({ timeSec: t, url });
        }
        reportProgress(Math.round((i / totalFrames) * 100));
      }

      allFramesRef.current = frames;

      // P1〜P10 自動検出（窓内の相対フレームで検出し、絶対時刻へオフセット）
      const relPts = detectPPoints(frames, fps);
      let pts = relPts.map(p => ({ ...p, timeSec: p.timeSec + windowStart }));

      // --- ステージ3: 高速区間（P3〜P8）を 60fps で撮り直して位置を精密化 ---
      const byId = new Map(pts.map(p => [p.id, p] as const));
      const fastFrom = byId.get('P3')?.timeSec;
      const fastTo = byId.get('P8')?.timeSec;
      if (fastFrom != null && fastTo != null && fastTo > fastFrom) {
        setBatchStage('refine');
        reportProgress(0);
        const fastEnd = Math.min(windowEnd, fastTo + FAST_PAD_SEC);
        const rawStart = Math.max(windowStart, fastFrom - FAST_PAD_SEC);
        // 本解析グリッドに乗るよう開始位置を丸める。こうすると高 fps 側の
        // 何コマかに一度が本解析と同じ時刻になり、そのぶん解析を省ける。
        const baseIdx = Math.max(0, Math.round((rawStart - windowStart) * fps));
        const fastStart = windowStart + baseIdx / fps;
        const fastDur = Math.max(fastEnd - fastStart, 0.05);
        // 本解析 fps の整数倍にして、重なるコマを再利用できるようにする
        const ratio = Math.max(1, Math.round(Math.min(FAST_FPS, Math.max(fps, MAX_FAST_FRAMES / fastDur)) / fps));
        const fastFps = fps * ratio;
        const fastStep = 1 / fastFps;
        const fastTotal = Math.max(1, Math.floor(fastDur * fastFps));
        const fastFrames: (NormalizedLandmark[] | null)[] = [];
        const fastThumbStride = Math.max(1, Math.ceil((fastTotal + 1) / THUMB_CANDIDATES));

        for (let i = 0; i <= fastTotal; i++) {
          const t = Math.min(fastStart + i * fastStep, fastEnd);

          // 本解析と同じ時刻のコマは解析済みなので使い回す（シークも推論も省略）
          const reuseIdx = i % ratio === 0 ? baseIdx + i / ratio : -1;
          if (reuseIdx >= 0 && reuseIdx < frames.length) {
            fastFrames.push(frames[reuseIdx]);
            reportProgress(Math.round((i / fastTotal) * 100));
            continue;
          }

          await seekAndWait(video, t);
          const result = detectPose(video);
          fastFrames.push(result?.landmarks ?? null);
          if (i % fastThumbStride === 0) {
            const url = captureThumbnail(video);
            if (url) collected.push({ timeSec: t, url });
          }
          reportProgress(Math.round((i / fastTotal) * 100));
        }

        fastFramesRef.current = fastFrames;
        fastStartRef.current = fastStart;
        fastFpsRef.current = fastFps;

        pts = refinePPoints(
          pts,
          { frames: fastFrames, fps: fastFps, startSec: fastStart },
          FAST_REFINE_IDS,
        );
      }

      // frameIndex を本解析グリッド基準に揃え直す（精密化で時刻が動いたため）
      pts = pts.map(p => ({ ...p, frameIndex: Math.round((p.timeSec - windowStart) * fps) }));
      pPointsRef.current = pts;
      setPPoints(pts);

      // コマ帯は P1〜P10 に密着させる（解析ウィンドウのままだとスイングが帯の
      // 一部に押し込められ、P 点が重なって見えるため）
      const firstT = pts[0]?.timeSec ?? windowStart;
      const lastT = pts[pts.length - 1]?.timeSec ?? windowEnd;
      const pad = Math.max(STRIP_PAD_MIN_SEC, (lastT - firstT) * STRIP_PAD_RATIO);
      const stripStart = Math.max(windowStart, firstT - pad);
      const stripEnd = Math.min(windowEnd, lastT + pad);
      setSwingWindow({ start: stripStart, end: stripEnd });
      setThumbs(pickEvenlySpacedThumbs(collected, stripStart, stripEnd, MAX_THUMBS));

      // 最初は P1 を選択した状態で始める（すぐ調整に入れるように）
      const firstId: PPointId = 'P1';
      selectedPIdRef.current = firstId;
      setSelectedPId(firstId);

      const startT = pts[0]?.timeSec ?? windowStart;
      video.currentTime = startT;
      setCurrentTime(startT);
    } finally {
      suppressSeekRef.current = false;
    }
    setState('ready');
    reportProgress(0);
  }, [reportProgress]);

  // ---------- File selected ----------
  const handleVideoSelected = useCallback((file: File) => {
    if (videoSrc) URL.revokeObjectURL(videoSrc);
    const url = URL.createObjectURL(file);
    setVideoSrc(url);
    setState('idle');
    canvasRef.current?.clear();
    cachedPoseRef.current = null;
    allFramesRef.current = [];
    fastFramesRef.current = [];
    windowStartRef.current = 0;
    windowEndRef.current = 0;
    pPointsRef.current = [];
    selectedPIdRef.current = null;
    setPPoints([]);
    setThumbs([]);
    setSwingWindow({ start: 0, end: 0 });
    setSelectedPId(null);
    setSaveMessage('');
    smootherRef.current.reset();
    interpolatorRef.current.reset();
    setZoom(1);
    setPanOffset({ x: 0, y: 0 });
    setRotation(0);
    setCurrentTime(0);
  }, [videoSrc]);

  // ---------- Video ready ----------
  const handleVideoReady = useCallback(async (video: HTMLVideoElement) => {
    setVideoDims({ width: video.videoWidth, height: video.videoHeight });
    video.pause();
    await loadModel();
    if (isPoseDetectorReady()) {
      await batchAnalyze();
    }
  }, [loadModel, batchAnalyze]);

  // ---------- Seeked ----------
  const handleSeeked = useCallback(() => {
    const video = playerRef.current?.getVideoElement();
    if (!video) return;
    if (suppressSeekRef.current) return; // 一括処理中はスキップ

    const t = video.currentTime;
    let landmarks = lookupCachedLandmarks(t);
    if (!landmarks && isPoseDetectorReady()) {
      // 解析ウィンドウ外への手動シークなど: ライブ推論にフォールバック
      const result = detectPose(video);
      landmarks = result?.landmarks ?? null;
    }
    cachedPoseRef.current = landmarks ? { landmarks, worldLandmarks: [] } : null;

    setCurrentTime(t);
    drawFrame(cachedPoseRef.current, selectedPIdRef.current);
  }, [drawFrame, lookupCachedLandmarks]);

  const handleTimeUpdate = useCallback((time: number) => {
    setCurrentTime(time);
  }, []);

  // ---------- Cleanup ----------
  useEffect(() => {
    return () => {
      disposePoseDetector();
      if (videoSrc) URL.revokeObjectURL(videoSrc);
    };
  }, [videoSrc]);

  // 表示設定変更 → 再描画
  useEffect(() => {
    drawFrame(cachedPoseRef.current, selectedPIdRef.current);
  }, [drawFrame]);

  useEffect(() => { drawGridOverlay(); }, [drawGridOverlay, view]);

  useEffect(() => {
    const h = () => drawGridOverlay();
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, [drawGridOverlay]);

  // クラブ一覧: 解析ビュー表示時にメインセットを再読込（クラブ設定タブでの編集を反映）
  useEffect(() => {
    if (view === 'analysis') setClubs(getMainSet()?.clubs ?? []);
  }, [view]);

  const handleClubSelect = useCallback((id: string) => {
    setSelectedClubId(id);
    try {
      localStorage.setItem(SELECTED_CLUB_KEY, id);
    } catch { /* 保存失敗は無視 */ }
  }, []);

  const selectedClub = clubs.find(c => c.id === selectedClubId) ?? null;

  // === P点選択 ===

  /** 指定の P 点を選択（null で選択解除）。選択時はその時刻へシークする */
  const selectP = useCallback((id: PPointId | null) => {
    selectedPIdRef.current = id;
    setSelectedPId(id);
    if (id) {
      const p = pPointsRef.current.find(x => x.id === id);
      if (p) playerRef.current?.seekTo(p.timeSec);
    }
  }, []);

  /** 前後の P 点へ 1 段ずつ移動（両端はクランプ） */
  const stepSelectedP = useCallback((dir: 'next' | 'prev') => {
    const prev = selectedPIdRef.current;
    let next: PPointId | null;
    if (prev === null) {
      next = dir === 'next' ? 'P1' : 'P10';
    } else {
      const idx = P_POINT_IDS.indexOf(prev);
      if (dir === 'next') {
        next = idx >= P_POINT_IDS.length - 1 ? prev : P_POINT_IDS[idx + 1];
      } else {
        next = idx <= 0 ? prev : P_POINT_IDS[idx - 1];
      }
    }
    selectP(next);
  }, [selectP]);

  /** 動画タップ: 左半分=前のP点、右半分=次のP点 */
  const handleViewportTap = useCallback((clientX: number) => {
    if (pPointsRef.current.length === 0) return; // 解析前は無効
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const ratio = (clientX - rect.left) / rect.width;
    stepSelectedP(ratio < 0.5 ? 'prev' : 'next');
  }, [stepSelectedP]);

  /** 選択中の P 点の時刻を更新しつつライブプレビュー */
  const updateSelectedPTime = useCallback((id: PPointId, timeSec: number) => {
    const fps = analysisFpsRef.current;
    const winStart = windowStartRef.current;
    const update = (prev: PPoint[]) =>
      prev.map(p => p.id === id ? { ...p, timeSec, frameIndex: Math.round((timeSec - winStart) * fps) } : p);
    pPointsRef.current = update(pPointsRef.current);
    setPPoints(update);
    playerRef.current?.seekTo(timeSec);
  }, []);

  /**
   * スクラブ共通処理。
   * P 点を選択中ならその P 点自体を動かし、未選択なら単なる再生位置移動になる。
   * 動画の横ドラッグとフィルムストリップの両方から呼ばれるので挙動が揃う。
   */
  const applyScrubTime = useCallback((rawTime: number) => {
    const dur = playerRef.current?.getDuration() ?? 0;
    if (dur === 0) return;

    const selId = selectedPIdRef.current;
    if (selId) {
      const idx = pPointsRef.current.findIndex(p => p.id === selId);
      if (idx >= 0) {
        updateSelectedPTime(selId, clampPPointTime(pPointsRef.current, idx, rawTime, dur));
        return;
      }
    }
    playerRef.current?.seekTo(Math.max(0, Math.min(dur, rawTime)));
  }, [updateSelectedPTime]);

  /** 現在の10点+使用クラブを記録として保存（保存時のみ骨格を焼き込んだ写真を書き出す） */
  const handleSaveRecord = useCallback(async () => {
    const video = playerRef.current?.getVideoElement();
    const pts = pPointsRef.current;
    if (!video || pts.length !== P_POINT_IDS.length || saving) return;

    setSaving(true);
    suppressSeekRef.current = true;
    try {
      const landmarksList = pts.map(p => lookupCachedLandmarks(p.timeSec));
      const urls = await extractFramesAt(
        video,
        pts.map(p => p.timeSec),
        undefined,
        undefined,
        landmarksList,
      );
      if (urls.some(u => !u)) {
        setSaveMessage('保存に失敗しました');
        return;
      }
      const record: SwingRecord = {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        clubId: selectedClub?.id ?? null,
        clubName: selectedClub?.name ?? '',
        clubHead: selectedClub?.head ?? '',
        // クラブは後で編集/削除されうるので、保存時点の全スペックを控えておく
        club: selectedClub ? { ...selectedClub } : null,
        frames: pts.map((p, i) => ({
          id: p.id,
          timeSec: p.timeSec,
          imageUrl: urls[i] as string,
          angles: anglesFor(landmarksList[i]),
        })),
      };
      saveRecord(record);
      setSaveMessage('記録に保存しました');
    } finally {
      suppressSeekRef.current = false;
      setSaving(false);
      window.setTimeout(() => setSaveMessage(''), 2500);
    }
  }, [saving, selectedClub, lookupCachedLandmarks]);

  // === タッチジェスチャー ===

  /**
   * 動画の横ドラッグ: 指を置いた位置からの累積 px で時刻を決定。
   * PX_PER_FRAME px = 1解析フレーム。
   */
  const handleHorizontalDrag = useCallback((totalDeltaPx: number) => {
    if (dragBaseTimeRef.current < 0) {
      dragBaseTimeRef.current = playerRef.current?.getCurrentTime() ?? 0;
    }
    const frameDelta = totalDeltaPx / PX_PER_FRAME;
    const timeDelta = frameDelta / analysisFpsRef.current;
    applyScrubTime(dragBaseTimeRef.current + timeDelta);
  }, [applyScrubTime]);

  const handleHorizontalDragEnd = useCallback(() => {
    dragBaseTimeRef.current = -1;
  }, []);

  useEffect(() => { dragBaseTimeRef.current = -1; }, [videoSrc]);

  const handlePinchZoom = useCallback((scale: number) => {
    setZoom(prev => Math.max(0.5, Math.min(5, prev * scale)));
  }, []);

  useTouchGestures(viewportRef, {
    onHorizontalDrag: handleHorizontalDrag,
    onHorizontalDragEnd: handleHorizontalDragEnd,
    onPinchZoom: handlePinchZoom,
    onTap: (x) => handleViewportTap(x),
  }, videoSrc);

  const handleRotation = useCallback((d: number) => setRotation(p => p + d), []);
  const handleResetTransform = useCallback(() => {
    setZoom(1); setPanOffset({ x: 0, y: 0 }); setRotation(0);
  }, []);

  // ビューポート表示計算
  // コマ帯・ツールバー・タブバーを足した高さを引き、画面内に収めて縦スクロールを不要にする
  const maxW = Math.min(videoDims.width, window.innerWidth);
  const maxH = window.innerHeight - 345;
  const baseScale = Math.min(maxW / videoDims.width, maxH / videoDims.height, 1);
  const displayWidth = Math.round(videoDims.width * baseScale);
  const displayHeight = Math.round(videoDims.height * baseScale);

  const canSave = state === 'ready' && pPoints.length === P_POINT_IDS.length;

  return (
    <div className="app">
      {/* ========== タブナビゲーション ========== */}
      <nav className="tab-bar">
        <button
          className={`tab-btn ${view === 'analysis' ? 'active' : ''}`}
          onClick={() => setView('analysis')}
        >
          📹 スイング解析
        </button>
        <button
          className={`tab-btn ${view === 'clubs' ? 'active' : ''}`}
          onClick={() => setView('clubs')}
        >
          🏌️ クラブ設定
        </button>
        <button
          className={`tab-btn ${view === 'history' ? 'active' : ''}`}
          onClick={() => setView('history')}
        >
          📋 記録
        </button>
        <button
          className={`tab-btn ${view === 'data' ? 'active' : ''}`}
          onClick={() => setView('data')}
        >
          ☁️ バックアップ
        </button>
      </nav>

      {/* ========== クラブ設定ビュー ========== */}
      {view === 'clubs' && <ClubManager />}

      {/* ========== 記録ビュー ========== */}
      {view === 'history' && <RecordHistory />}

      {/* ========== バックアップ / 復元ビュー ========== */}
      {view === 'data' && <DataSync />}

      {/* ========== 解析ビュー（動画状態保持のため display 切替） ========== */}
      <div style={{ display: view === 'analysis' ? 'contents' : 'none' }}>
        {/* ---------- アップロード画面 ---------- */}
        {!videoSrc && (
          <>
            <header className="app-header">
              <h1>🏌️ ゴルフスイング モーション解析</h1>
              {state === 'loading-model' && (
                <div className="model-loading">
                  <div className="spinner" />
                  <span>ポーズ検出モデルを読み込み中...</span>
                </div>
              )}
            </header>
            <VideoUploader
              onVideoSelected={handleVideoSelected}
              disabled={state === 'loading-model'}
            />
          </>
        )}

        {/* ---------- 解析画面 ---------- */}
        {videoSrc && (
          <div className="analysis-area">
            {/* モデル / バッチ解析ローディング */}
            {view === 'analysis' && (state === 'loading-model' || state === 'batch-analyzing') && (
              <div className="model-loading-overlay">
                <div className="spinner" />
                <span>
                  {state === 'loading-model' ? (
                    'ポーズ検出モデルを読み込み中...'
                  ) : (
                    <>
                      {batchStage === 'scan'
                        ? 'スイング区間を推定中... '
                        : batchStage === 'pose'
                          ? '詳細解析中... '
                          : '高速区間を精密解析中... '}
                      {/* 進捗の数値だけ DOM 直書きで更新する（再描画を避けるため） */}
                      <span ref={progressTextRef}>0%</span>
                    </>
                  )}
                </span>
                {state === 'batch-analyzing' && (
                  <div className="batch-progress-bar">
                    <div className="batch-progress-fill" ref={progressFillRef} />
                  </div>
                )}
              </div>
            )}

            {/* ビューポート（左右タップでP点切替、横ドラッグで微調整） */}
            <div
              ref={viewportRef}
              className="viewport"
              style={{ width: displayWidth, height: displayHeight }}
            >
              <div
                className="viewport-transform"
                style={{
                  transform: `scale(${zoom}) translate(${panOffset.x}px, ${panOffset.y}px) rotate(${rotation}deg)`,
                  transformOrigin: 'center center',
                }}
              >
                <VideoPlayer
                  ref={playerRef}
                  src={videoSrc}
                  onReady={handleVideoReady}
                  onSeeked={handleSeeked}
                  onTimeUpdate={handleTimeUpdate}
                />
                <SkeletonCanvas
                  ref={canvasRef}
                  width={videoDims.width}
                  height={videoDims.height}
                />
              </div>

              {/* グリッド: 固定オーバーレイ */}
              <canvas ref={gridCanvasRef} className="grid-canvas" />
            </div>

            {/* スイング区間のコマ帯（iPhone 連続写真ピッカー風） */}
            <PPointFilmstrip
              thumbs={thumbs}
              windowStart={swingWindow.start}
              windowEnd={swingWindow.end}
              currentTime={currentTime}
              pPoints={pPoints}
              selectedId={selectedPId}
              onScrub={applyScrubTime}
              onScrubEnd={() => { dragBaseTimeRef.current = -1; }}
              onSelectP={selectP}
              disabled={state !== 'ready' || saving}
            />

            {/* ミニツールバー */}
            <div className="mini-toolbar">
              <div className="toolbar-row">
                <button
                  className={`btn-upload-new${showViewOptions ? ' active' : ''}`}
                  onClick={() => setShowViewOptions(v => !v)}
                >
                  ⚙ 表示設定
                </button>

                {/* 使用クラブ選択 */}
                <select
                  className="club-select"
                  value={selectedClubId}
                  onChange={(e) => handleClubSelect(e.target.value)}
                  title="この動画で使用したクラブ"
                >
                  <option value="">使用クラブ: 未選択</option>
                  {clubs.map(c => (
                    <option key={c.id} value={c.id}>{c.name}{c.head ? ` (${c.head})` : ''}</option>
                  ))}
                </select>
                {selectedClub && (
                  <span className="club-spec-chip">
                    {selectedClub.loftDeg != null ? `ロフト${selectedClub.loftDeg}° ` : ''}
                    {selectedClub.lengthInch != null ? `${selectedClub.lengthInch}"` : ''}
                  </span>
                )}
              </div>

              {/* 表示オプション（折りたたみ、既定では隠して画面をすっきりさせる） */}
              {showViewOptions && (
                <div className="toolbar-row view-options-row">
                  <label className="toggle-chip">
                    <input type="checkbox" checked={showSkeleton} onChange={(e) => setShowSkeleton(e.target.checked)} />
                    骨格
                  </label>
                  <label className="toggle-chip">
                    <input type="checkbox" checked={showAngles} onChange={(e) => setShowAngles(e.target.checked)} />
                    角度
                  </label>
                  <label className="toggle-chip">
                    <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} />
                    グリッド
                  </label>

                  <span className="separator" />

                  <button className="icon-btn" onClick={() => handleRotation(-1)} title="左回転">↶</button>
                  <span className="rotation-display">{rotation}°</span>
                  <button className="icon-btn" onClick={() => handleRotation(1)} title="右回転">↷</button>

                  {(zoom !== 1 || rotation !== 0) && (
                    <button className="icon-btn" onClick={handleResetTransform} title="リセット">⟲</button>
                  )}
                </div>
              )}

              <div className="toolbar-row">
                <button
                  className="btn-upload-new"
                  onClick={() => {
                    canvasRef.current?.clear();
                    if (videoSrc) URL.revokeObjectURL(videoSrc);
                    setVideoSrc(null);
                    setState('idle');
                    cachedPoseRef.current = null;
                    allFramesRef.current = [];
                    pPointsRef.current = [];
                    selectedPIdRef.current = null;
                    setPPoints([]);
                    setThumbs([]);
                    setSelectedPId(null);
                    setSaveMessage('');
                  }}
                >
                  別の動画を選択
                </button>
                {state === 'ready' && (
                  <button className="btn-upload-new" onClick={batchAnalyze}>
                    再解析
                  </button>
                )}
                {canSave && (
                  <button className="btn-upload-new btn-save-record" onClick={handleSaveRecord} disabled={saving}>
                    {saving ? '保存中...' : '💾 記録に保存'}
                  </button>
                )}
                {saveMessage && <span className="save-message">{saveMessage}</span>}
              </div>
            </div>
          </div>
        )}
      </div>

      {state === 'error' && (
        <div className="error-banner">
          <p>{errorMsg}</p>
          <button onClick={() => { setState('idle'); setErrorMsg(''); }}>閉じる</button>
        </div>
      )}
    </div>
  );
}
