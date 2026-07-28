import { useState, useRef, useCallback, useEffect } from 'react';
import VideoUploader from './components/VideoUploader';
import VideoPlayer, { type VideoPlayerHandle } from './components/VideoPlayer';
import SkeletonCanvas, { type SkeletonCanvasHandle } from './components/SkeletonCanvas';
import PPointTimeline from './components/PPointTimeline';
import PPointGallery from './components/PPointGallery';
import ClubManager from './components/ClubManager';
import RecordHistory from './components/RecordHistory';
import { initPoseDetector, detectPose, disposePoseDetector, isPoseDetectorReady, type PoseResult } from './services/poseDetector';
import { drawSkeleton } from './services/skeletonRenderer';
import { calculateAngles, drawAngles } from './services/angleCalculator';
import { drawGrid } from './services/gridRenderer';
import { LandmarkSmoother } from './services/landmarkSmoother';
import { ConfidenceInterpolator } from './services/confidenceInterpolator';
import { detectPPoints, estimateSwingWindow } from './services/pPositionDetector';
import { extractFramesAt, extractFrameAt, seekAndWait } from './services/frameExtractor';
import { getMainSet } from './services/clubSetStore';
import { saveRecord } from './services/recordStore';
import { useTouchGestures } from './hooks/useTouchGestures';
import { P_POINT_IDS, P_POINT_INFO, clampPPointTime, type PPoint, type PPointId, type PPointFrame } from './types/ppoint';
import type { Club } from './types/club';
import type { SwingRecord } from './types/record';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import './App.css';

type AppState = 'idle' | 'loading-model' | 'ready' | 'batch-analyzing' | 'error';
type AppView = 'analysis' | 'clubs' | 'history';
/** バッチ解析の3段階: 粗いスキャン → 窓内本解析 → P点フレーム切り出し */
type BatchStage = 'scan' | 'pose' | 'extract';

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
/** ドラッグ何 px で 1 フレーム送り */
const PX_PER_FRAME = 30;
/** 使用クラブ選択の保存キー */
const SELECTED_CLUB_KEY = 'golf-motion.selectedClub';

export default function App() {
  const [state, setState] = useState<AppState>('idle');
  const [view, setView] = useState<AppView>('analysis');
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [showSkeleton, setShowSkeleton] = useState(true);
  const [showAngles, setShowAngles] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [videoDims, setVideoDims] = useState({ width: 640, height: 480 });
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  /** 表示オプション（骨格/角度/グリッド/回転）パネルの開閉。既定は閉じてUIをすっきりさせる */
  const [showViewOptions, setShowViewOptions] = useState(false);
  const [batchProgress, setBatchProgress] = useState(0); // 0~100 (各ステージ毎)
  const [batchStage, setBatchStage] = useState<BatchStage>('scan');

  // P システム
  const [pPoints, setPPoints] = useState<PPoint[]>([]);
  const [pFrames, setPFrames] = useState<PPointFrame[]>([]);
  const [extracting, setExtracting] = useState(false);
  /** 現在の再生位置に最も近い P 点（ギャラリーのハイライト用） */
  const [activePId, setActivePId] = useState<PPointId | null>(null);
  /** タイムラインで編集対象として選択中の P 点（null = P0 = 未選択） */
  const [selectedPId, setSelectedPId] = useState<PPointId | null>(null);
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
  const pPointsRef = useRef<PPoint[]>([]);
  const selectedPIdRef = useRef<PPointId | null>(null);
  /** 一括処理中は seeked ハンドラの再解析を抑止する */
  const suppressSeekRef = useRef(false);

  // ドラッグ時の基準時刻
  const dragBaseTimeRef = useRef(0);

  // ---------- 窓内キャッシュからランドマークを引く（ライブ推論を避けて遅延を防ぐ） ----------
  const lookupCachedLandmarks = useCallback((timeSec: number): NormalizedLandmark[] | null => {
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

  // ---------- P点フレーム一括切り出し（骨格・角度を焼き込む） ----------
  const extractAllPFrames = useCallback(async (pts: PPoint[]) => {
    const video = playerRef.current?.getVideoElement();
    if (!video || pts.length === 0) return;
    setExtracting(true);
    setBatchStage('extract');
    setBatchProgress(0);
    suppressSeekRef.current = true;
    try {
      const landmarksList = pts.map(p => lookupCachedLandmarks(p.timeSec));
      const urls = await extractFramesAt(
        video,
        pts.map(p => p.timeSec),
        (done, total) => setBatchProgress(Math.round((done / total) * 100)),
        undefined,
        landmarksList,
      );
      setPFrames(pts.map((p, i) => ({ id: p.id, timeSec: p.timeSec, imageUrl: urls[i] })));
    } finally {
      suppressSeekRef.current = false;
      setExtracting(false);
    }
  }, [lookupCachedLandmarks]);

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
      setBatchProgress(0);
      const coarseFps = Math.min(COARSE_FPS, Math.max(1, MAX_COARSE_FRAMES / Math.max(dur, 0.1)));
      const coarseStep = 1 / coarseFps;
      const coarseTotal = Math.max(1, Math.floor(dur * coarseFps));
      const coarseFrames: (NormalizedLandmark[] | null)[] = [];

      for (let i = 0; i <= coarseTotal; i++) {
        const t = Math.min(i * coarseStep, dur);
        await seekAndWait(video, t);
        const result = detectPose(video);
        coarseFrames.push(result?.landmarks ?? null);
        setBatchProgress(Math.round((i / coarseTotal) * 100));
      }

      const estimate = estimateSwingWindow(coarseFrames, coarseFps);
      const windowStart = Math.max(0, estimate.startSec - WINDOW_PAD_SEC);
      const windowEnd = Math.min(dur, estimate.endSec + WINDOW_PAD_SEC);
      windowStartRef.current = windowStart;
      windowEndRef.current = windowEnd;

      // --- ステージ2: 窓内のみ 20fps で本解析（処理を軽くする） ---
      setBatchStage('pose');
      setBatchProgress(0);
      const windowDur = Math.max(windowEnd - windowStart, 0.1);
      const fps = Math.min(ANALYSIS_FPS, Math.max(1, MAX_WINDOW_FRAMES / windowDur));
      analysisFpsRef.current = fps;
      const step = 1 / fps;
      const totalFrames = Math.max(1, Math.floor(windowDur * fps));
      const frames: (NormalizedLandmark[] | null)[] = [];

      for (let i = 0; i <= totalFrames; i++) {
        const t = Math.min(windowStart + i * step, windowEnd);
        await seekAndWait(video, t);
        const result = detectPose(video);
        frames.push(result?.landmarks ?? null);
        setBatchProgress(Math.round((i / totalFrames) * 100));
      }

      allFramesRef.current = frames;

      // P1〜P10 自動検出（窓内の相対フレームで検出し、絶対時刻へオフセット）
      const relPts = detectPPoints(frames, fps);
      const pts = relPts.map(p => ({ ...p, timeSec: p.timeSec + windowStart }));
      pPointsRef.current = pts;
      setPPoints(pts);
      setSelectedPId(null);
      selectedPIdRef.current = null;
      setActivePId(null);

      // P点のフレーム写真を一括切り出し
      await extractAllPFrames(pts);

      // P1 (アドレス) へシーク
      const startT = pts[0]?.timeSec ?? windowStart;
      video.currentTime = startT;
      setCurrentTime(startT);
    } finally {
      suppressSeekRef.current = false;
    }
    setState('ready');
    setBatchProgress(0);
  }, [extractAllPFrames]);

  // ---------- 現在時刻に最も近い P 点を求める（純関数、state 非依存） ----------
  const findNearestPId = useCallback((time: number): PPointId | null => {
    const pts = pPointsRef.current;
    if (pts.length === 0) return null;
    const tol = Math.max(0.5 / analysisFpsRef.current, 0.08);
    let best: PPointId | null = null;
    let bestD = tol;
    for (const p of pts) {
      const d = Math.abs(p.timeSec - time);
      if (d <= bestD) {
        bestD = d;
        best = p.id;
      }
    }
    return best;
  }, []);

  // ---------- File selected ----------
  const handleVideoSelected = useCallback((file: File) => {
    if (videoSrc) URL.revokeObjectURL(videoSrc);
    const url = URL.createObjectURL(file);
    setVideoSrc(url);
    setState('idle');
    canvasRef.current?.clear();
    cachedPoseRef.current = null;
    allFramesRef.current = [];
    windowStartRef.current = 0;
    windowEndRef.current = 0;
    pPointsRef.current = [];
    selectedPIdRef.current = null;
    setPPoints([]);
    setPFrames([]);
    setActivePId(null);
    setSelectedPId(null);
    setSaveMessage('');
    smootherRef.current.reset();
    interpolatorRef.current.reset();
    setZoom(1);
    setPanOffset({ x: 0, y: 0 });
    setRotation(0);
    setProgress(0);
    setCurrentTime(0);
    setDuration(0);
  }, [videoSrc]);

  // ---------- Video ready ----------
  const handleVideoReady = useCallback(async (video: HTMLVideoElement) => {
    setVideoDims({ width: video.videoWidth, height: video.videoHeight });
    setDuration(video.duration);
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

    const nearP = findNearestPId(t);
    setActivePId(nearP);
    setCurrentTime(t);
    drawFrame(cachedPoseRef.current, nearP);
  }, [drawFrame, findNearestPId, lookupCachedLandmarks]);

  const handleTimeUpdate = useCallback((time: number, dur: number) => {
    if (dur > 0) setProgress(time / dur);
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
    const t = playerRef.current?.getCurrentTime() ?? 0;
    drawFrame(cachedPoseRef.current, findNearestPId(t));
  }, [drawFrame, findNearestPId]);

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

  // === P点選択（P0 起点のステップ選択） ===

  /** 指定の P 点を選択（null で選択解除=P0）。選択時はその時刻へシークする */
  const selectP = useCallback((id: PPointId | null) => {
    selectedPIdRef.current = id;
    setSelectedPId(id);
    if (id) {
      const p = pPointsRef.current.find(x => x.id === id);
      if (p) playerRef.current?.seekTo(p.timeSec);
    }
  }, []);

  /** P0 ⇄ P1 ⇄ P2 ⇄ ... ⇄ P10 を左右で1段ずつ移動（両端はクランプ） */
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
        next = idx <= 0 ? null : P_POINT_IDS[idx - 1];
      }
    }
    selectP(next);
  }, [selectP]);

  /** 動画タップ: 左1/3=前のP点、右1/3=次のP点、中央=選択解除(P0) */
  const handleViewportTap = useCallback((clientX: number) => {
    if (pPointsRef.current.length === 0) return; // 解析前は無効
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const ratio = (clientX - rect.left) / rect.width;
    if (ratio < 1 / 3) stepSelectedP('prev');
    else if (ratio > 2 / 3) stepSelectedP('next');
    else selectP(null);
  }, [stepSelectedP, selectP]);

  /** マーカードラッグ中: P点位置を更新しつつライブプレビュー */
  const handleMarkerDrag = useCallback((id: PPointId, timeSec: number) => {
    const fps = analysisFpsRef.current;
    const winStart = windowStartRef.current;
    const update = (prev: PPoint[]) =>
      prev.map(p => p.id === id ? { ...p, timeSec, frameIndex: Math.round((timeSec - winStart) * fps) } : p);
    pPointsRef.current = update(pPointsRef.current);
    setPPoints(update);
    playerRef.current?.seekTo(timeSec);
  }, []);

  /** マーカードラッグ確定: そのP点のフレーム写真を再取得（骨格焼き込み込み） */
  const handleMarkerDragEnd = useCallback(async (id: PPointId, timeSec: number) => {
    handleMarkerDrag(id, timeSec);
    const video = playerRef.current?.getVideoElement();
    if (!video) return;
    const overlay = lookupCachedLandmarks(timeSec);
    const url = await extractFrameAt(video, timeSec, undefined, overlay);
    setPFrames(prev => prev.map(f => f.id === id ? { ...f, timeSec, imageUrl: url } : f));
  }, [handleMarkerDrag, lookupCachedLandmarks]);

  /** ギャラリーのカードタップ → 選択トグル（同じカードなら選択解除） */
  const handleGallerySelect = useCallback((id: PPointId) => {
    selectP(selectedPIdRef.current === id ? null : id);
  }, [selectP]);

  /** 10枚一括再切り出し */
  const handleExtractAll = useCallback(() => {
    void extractAllPFrames(pPointsRef.current);
  }, [extractAllPFrames]);

  /** 現在の10枚+使用クラブを記録として保存 */
  const handleSaveRecord = useCallback(() => {
    if (pFrames.length !== 10 || pFrames.some(f => !f.imageUrl)) return;
    const record: SwingRecord = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      clubId: selectedClub?.id ?? null,
      clubName: selectedClub?.name ?? '',
      clubHead: selectedClub?.head ?? '',
      frames: pFrames.map(f => ({ id: f.id, timeSec: f.timeSec, imageUrl: f.imageUrl as string })),
    };
    saveRecord(record);
    setSaveMessage('保存しました');
    window.setTimeout(() => setSaveMessage(''), 2500);
  }, [pFrames, selectedClub]);

  // === タッチジェスチャー ===

  /**
   * 横ドラッグ: 指を置いた位置からの累積 px で時刻を決定。
   * PX_PER_FRAME px = 1解析フレーム。
   *
   * P点選択中（P0 でない）は、この使い慣れた大きな動画エリアのドラッグで
   * 選択中の P点自体を微調整する（タイムライン上の小さなつまみを正確に
   * つまむ必要をなくすため）。未選択時は通常どおり再生位置のスクラブになる。
   */
  const handleHorizontalDrag = useCallback((totalDeltaPx: number) => {
    const dur = playerRef.current?.getDuration() ?? 0;
    if (dur === 0) return;

    if (dragBaseTimeRef.current < 0) {
      dragBaseTimeRef.current = playerRef.current?.getCurrentTime() ?? 0;
    }

    const frameDelta = totalDeltaPx / PX_PER_FRAME;
    const timeDelta = frameDelta / analysisFpsRef.current;
    const rawTime = dragBaseTimeRef.current + timeDelta;

    const selId = selectedPIdRef.current;
    if (selId) {
      const idx = pPointsRef.current.findIndex(p => p.id === selId);
      if (idx >= 0) {
        handleMarkerDrag(selId, clampPPointTime(pPointsRef.current, idx, rawTime, dur));
        return;
      }
    }

    playerRef.current?.seekTo(Math.max(0, Math.min(dur, rawTime)));
  }, [handleMarkerDrag]);

  const handleHorizontalDragEnd = useCallback(() => {
    const selId = selectedPIdRef.current;
    if (selId) {
      const p = pPointsRef.current.find(x => x.id === selId);
      if (p) void handleMarkerDragEnd(selId, p.timeSec);
    }
    dragBaseTimeRef.current = -1;
  }, [handleMarkerDragEnd]);

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
  const maxW = Math.min(videoDims.width, window.innerWidth);
  const maxH = window.innerHeight - 180;
  const baseScale = Math.min(maxW / videoDims.width, maxH / videoDims.height, 1);
  const displayWidth = Math.round(videoDims.width * baseScale);
  const displayHeight = Math.round(videoDims.height * baseScale);

  const canSave = pFrames.length === 10 && pFrames.every(f => f.imageUrl) && state === 'ready';

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
      </nav>

      {/* ========== クラブ設定ビュー ========== */}
      {view === 'clubs' && <ClubManager />}

      {/* ========== 記録ビュー ========== */}
      {view === 'history' && <RecordHistory />}

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
                  {state === 'loading-model'
                    ? 'ポーズ検出モデルを読み込み中...'
                    : batchStage === 'scan'
                      ? `スイング区間を推定中... ${batchProgress}%`
                      : batchStage === 'pose'
                        ? `詳細解析中... ${batchProgress}%`
                        : `P点フレーム切り出し中... ${batchProgress}%`}
                </span>
                {state === 'batch-analyzing' && (
                  <div className="batch-progress-bar">
                    <div className="batch-progress-fill" style={{ width: `${batchProgress}%` }} />
                  </div>
                )}
              </div>
            )}

            {/* ビューポート（左/右/中央タップでP点切替・選択解除） */}
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

              {/* シークプログレスバー */}
              <div className="seek-progress-bar">
                <div className="seek-progress-fill" style={{ width: `${progress * 100}%` }} />
                <input
                  type="range"
                  className="seek-progress-input"
                  min={0}
                  max={1}
                  step={0.0001}
                  value={progress}
                  onChange={(e) => {
                    const ratio = parseFloat(e.target.value);
                    const dur = playerRef.current?.getDuration() ?? 0;
                    playerRef.current?.seekTo(ratio * dur);
                  }}
                />
              </div>
            </div>

            {/* P点タイムライン（選択中の1点のみ操作可能なマーカーとして表示） */}
            <PPointTimeline
              pPoints={pPoints}
              duration={duration}
              currentTime={currentTime}
              selectedId={selectedPId}
              onSeek={(t) => playerRef.current?.seekTo(t)}
              onMarkerDrag={handleMarkerDrag}
              onMarkerDragEnd={handleMarkerDragEnd}
              disabled={state !== 'ready' || extracting}
            />

            {/* P点の状態表示 + 状況に応じたヒント（シンプルに1行で） */}
            <div className="p-status-row">
              <span className="p-select-chip">
                {selectedPId ? `✎ ${P_POINT_INFO[selectedPId].label}` : 'P0（未選択）'}
              </span>
              <span className="hint-text">
                {state !== 'ready'
                  ? ''
                  : selectedPId
                    ? '動画を横ドラッグで位置調整 ・ タップで解除'
                    : '動画をタップしてP点を選択（左/右で切替）'}
              </span>
            </div>

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
                    setPFrames([]);
                    setActivePId(null);
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
                  <button className="btn-upload-new btn-save-record" onClick={handleSaveRecord}>
                    💾 記録に保存
                  </button>
                )}
                {saveMessage && <span className="save-message">{saveMessage}</span>}
              </div>
            </div>

            {/* P点ギャラリー（10枚の分解写真） */}
            <PPointGallery
              frames={pFrames}
              activeId={activePId}
              extracting={extracting}
              onSelect={handleGallerySelect}
              onExtractAll={handleExtractAll}
            />
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
