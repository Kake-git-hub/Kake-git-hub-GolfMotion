import { useState, useRef, useCallback, useEffect } from 'react';
import VideoUploader from './components/VideoUploader';
import VideoPlayer, { type VideoPlayerHandle } from './components/VideoPlayer';
import SkeletonCanvas, { type SkeletonCanvasHandle } from './components/SkeletonCanvas';
import PPointTimeline from './components/PPointTimeline';
import PPointGallery from './components/PPointGallery';
import ClubManager from './components/ClubManager';
import { initPoseDetector, detectPose, disposePoseDetector, isPoseDetectorReady, type PoseResult } from './services/poseDetector';
import { drawSkeleton } from './services/skeletonRenderer';
import { calculateAngles, drawAngles } from './services/angleCalculator';
import { drawGrid } from './services/gridRenderer';
import { LandmarkSmoother } from './services/landmarkSmoother';
import { ConfidenceInterpolator } from './services/confidenceInterpolator';
import { SwingPhaseDetector, drawPhaseLabel, drawPhaseTimeline, getPhaseInfo, type SwingPhase } from './services/swingPhaseDetector';
import { detectPPoints } from './services/pPositionDetector';
import { extractFramesAt, extractFrameAt, seekAndWait } from './services/frameExtractor';
import { loadClubs } from './services/clubStore';
import { useTouchGestures } from './hooks/useTouchGestures';
import type { PPoint, PPointId, PPointFrame } from './types/ppoint';
import type { Club } from './types/club';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import './App.css';

type AppState = 'idle' | 'loading-model' | 'ready' | 'batch-analyzing' | 'error';
type AppView = 'analysis' | 'clubs';

/** バッチ解析の目標 FPS（ダウンスイングは約0.25秒しかないため、P5/P6/P7 の分解能確保に 20fps） */
const ANALYSIS_FPS = 20;
/** バッチ解析の最大フレーム数（長尺動画では FPS を自動的に落とす） */
const MAX_ANALYSIS_FRAMES = 600;
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
  const [showPhase, setShowPhase] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [videoDims, setVideoDims] = useState({ width: 640, height: 480 });
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  const [currentPhase, setCurrentPhase] = useState<SwingPhase>('unknown');
  const [batchProgress, setBatchProgress] = useState(0); // 0~100
  const [batchStage, setBatchStage] = useState<'pose' | 'extract'>('pose');

  // P システム
  const [pPoints, setPPoints] = useState<PPoint[]>([]);
  const [pFrames, setPFrames] = useState<PPointFrame[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [activePId, setActivePId] = useState<PPointId | null>(null);

  // クラブ
  const [clubs, setClubs] = useState<Club[]>([]);
  const [selectedClubId, setSelectedClubId] = useState<string>(
    () => localStorage.getItem(SELECTED_CLUB_KEY) ?? '',
  );

  const playerRef = useRef<VideoPlayerHandle>(null);
  const canvasRef = useRef<SkeletonCanvasHandle>(null);
  const gridCanvasRef = useRef<HTMLCanvasElement>(null);
  const phaseCanvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  // 解析パイプライン
  const smootherRef = useRef(new LandmarkSmoother(1.7, 0.01));
  const interpolatorRef = useRef(new ConfidenceInterpolator(3));
  const phaseDetectorRef = useRef(new SwingPhaseDetector());

  // 全フレーム解析結果キャッシュ
  const allFramesRef = useRef<(NormalizedLandmark[] | null)[]>([]);
  const allPhasesRef = useRef<SwingPhase[]>([]);
  const videoDurRef = useRef(0);
  const cachedPoseRef = useRef<PoseResult | null>(null);
  /** 実際に使用したバッチ解析 FPS（長尺動画では ANALYSIS_FPS より低くなる） */
  const analysisFpsRef = useRef(ANALYSIS_FPS);
  const pPointsRef = useRef<PPoint[]>([]);
  /** 一括切り出し中は seeked ハンドラの再解析を抑止する */
  const suppressSeekRef = useRef(false);

  // ドラッグ時の基準時刻
  const dragBaseTimeRef = useRef(0);

  // ---------- drawFrame ----------
  const drawFrame = useCallback((poseResult: PoseResult | null, phase?: SwingPhase) => {
    const ctx = canvasRef.current?.getContext();
    if (!ctx) return;
    const { width, height } = videoDims;
    ctx.clearRect(0, 0, width, height);

    if (poseResult) {
      // smoother + interpolator
      const ts = performance.now() / 1000;
      const smoothed = smootherRef.current.smooth(poseResult.landmarks, ts);
      interpolatorRef.current.push(smoothed);
      const final = interpolatorRef.current.getCurrent() ?? smoothed;

      if (showSkeleton) drawSkeleton(ctx, final, width, height);
      if (showAngles) {
        const angles = calculateAngles(final);
        drawAngles(ctx, angles, width, height);
      }
      if (showPhase && phase && phase !== 'unknown') {
        drawPhaseLabel(ctx, phase, width);
      }
    }
  }, [videoDims, showSkeleton, showAngles, showPhase]);

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

  // ---------- Phase timeline overlay ----------
  const drawPhaseTimelineOverlay = useCallback(() => {
    const canvas = phaseCanvasRef.current;
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
    if (showPhase && allPhasesRef.current.length > 0) {
      drawPhaseTimeline(ctx, allPhasesRef.current, w, h, 0);
    }
  }, [showPhase]);

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

  // ---------- P点フレーム一括切り出し ----------
  const extractAllPFrames = useCallback(async (pts: PPoint[]) => {
    const video = playerRef.current?.getVideoElement();
    if (!video || pts.length === 0) return;
    setExtracting(true);
    setBatchStage('extract');
    suppressSeekRef.current = true;
    try {
      const urls = await extractFramesAt(
        video,
        pts.map(p => p.timeSec),
        (done, total) => setBatchProgress(Math.round((done / total) * 100)),
      );
      setPFrames(pts.map((p, i) => ({ id: p.id, timeSec: p.timeSec, imageUrl: urls[i] })));
    } finally {
      suppressSeekRef.current = false;
      setExtracting(false);
    }
  }, []);

  // ---------- 全フレーム一括解析 ----------
  const batchAnalyze = useCallback(async () => {
    const video = playerRef.current?.getVideoElement();
    if (!video || !isPoseDetectorReady()) return;

    setState('batch-analyzing');
    setBatchStage('pose');
    const dur = video.duration;
    videoDurRef.current = dur;
    // 長尺動画では FPS を落として最大フレーム数に収める
    const fps = Math.min(ANALYSIS_FPS, Math.max(1, MAX_ANALYSIS_FRAMES / Math.max(dur, 0.1)));
    analysisFpsRef.current = fps;
    const step = 1 / fps;
    const totalFrames = Math.floor(dur * fps);
    const frames: (NormalizedLandmark[] | null)[] = [];

    suppressSeekRef.current = true;
    try {
      for (let i = 0; i <= totalFrames; i++) {
        const t = Math.min(i * step, dur);
        await seekAndWait(video, t);
        const result = detectPose(video);
        frames.push(result?.landmarks ?? null);
        setBatchProgress(Math.round((i / totalFrames) * 100));
      }
    } finally {
      suppressSeekRef.current = false;
    }

    allFramesRef.current = frames;

    // スイングフェーズ検出
    const validFrames = frames.map(f => f ?? []);
    allPhasesRef.current = phaseDetectorRef.current.analyze(validFrames, fps);

    // P1〜P10 自動検出
    const pts = detectPPoints(frames, fps);
    pPointsRef.current = pts;
    setPPoints(pts);

    // P点のフレーム写真を一括切り出し
    await extractAllPFrames(pts);

    // P1 (アドレス) へシーク
    const startT = pts[0]?.timeSec ?? 0;
    video.currentTime = startT;
    setState('ready');
    setBatchProgress(0);
  }, [extractAllPFrames]);

  // ---------- curFrame から phase を引く ----------
  const getPhaseForTime = useCallback((time: number): SwingPhase => {
    const phases = allPhasesRef.current;
    if (phases.length === 0) return 'unknown';
    const idx = Math.round(time * analysisFpsRef.current);
    return phases[Math.max(0, Math.min(idx, phases.length - 1))];
  }, []);

  // ---------- 現在時刻に対応する P 点を求める ----------
  const updateActivePForTime = useCallback((time: number) => {
    const pts = pPointsRef.current;
    if (pts.length === 0) {
      setActivePId(null);
      return;
    }
    // 半フレーム + α を許容範囲とする
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
    setActivePId(best);
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
    allPhasesRef.current = [];
    pPointsRef.current = [];
    setPPoints([]);
    setPFrames([]);
    setActivePId(null);
    smootherRef.current.reset();
    interpolatorRef.current.reset();
    setZoom(1);
    setPanOffset({ x: 0, y: 0 });
    setRotation(0);
    setProgress(0);
    setCurrentTime(0);
    setDuration(0);
    setCurrentPhase('unknown');
  }, [videoSrc]);

  // ---------- Video ready ----------
  const handleVideoReady = useCallback(async (video: HTMLVideoElement) => {
    setVideoDims({ width: video.videoWidth, height: video.videoHeight });
    setDuration(video.duration);
    videoDurRef.current = video.duration;
    video.pause();
    await loadModel();
    // モデル読み込み完了後に全フレーム一括解析を開始
    if (isPoseDetectorReady()) {
      await batchAnalyze();
    }
  }, [loadModel, batchAnalyze]);

  // ---------- Seeked ----------
  const handleSeeked = useCallback(() => {
    const video = playerRef.current?.getVideoElement();
    if (!video || !isPoseDetectorReady()) return;
    if (suppressSeekRef.current) return;  // 一括処理中はスキップ

    const result = detectPose(video);
    if (result) cachedPoseRef.current = result;

    const phase = getPhaseForTime(video.currentTime);
    setCurrentPhase(phase);
    setCurrentTime(video.currentTime);
    updateActivePForTime(video.currentTime);
    drawFrame(cachedPoseRef.current, phase);
  }, [drawFrame, getPhaseForTime, updateActivePForTime]);

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
    const phase = getPhaseForTime(playerRef.current?.getCurrentTime() ?? 0);
    drawFrame(cachedPoseRef.current, phase);
  }, [drawFrame, getPhaseForTime]);

  useEffect(() => { drawGridOverlay(); }, [drawGridOverlay, view]);
  useEffect(() => { drawPhaseTimelineOverlay(); }, [drawPhaseTimelineOverlay, view]);

  useEffect(() => {
    const h = () => { drawGridOverlay(); drawPhaseTimelineOverlay(); };
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, [drawGridOverlay, drawPhaseTimelineOverlay]);

  // クラブ一覧: 解析ビュー表示時に再読込（クラブ設定タブでの編集を反映）
  useEffect(() => {
    if (view === 'analysis') setClubs(loadClubs());
  }, [view]);

  const handleClubSelect = useCallback((id: string) => {
    setSelectedClubId(id);
    try {
      localStorage.setItem(SELECTED_CLUB_KEY, id);
    } catch { /* 保存失敗は無視 */ }
  }, []);

  const selectedClub = clubs.find(c => c.id === selectedClubId) ?? null;

  // === P点タイムライン操作 ===

  /** マーカードラッグ中: P点位置を更新しつつライブプレビュー */
  const handleMarkerDrag = useCallback((id: PPointId, timeSec: number) => {
    const fps = analysisFpsRef.current;
    const update = (prev: PPoint[]) =>
      prev.map(p => p.id === id ? { ...p, timeSec, frameIndex: Math.round(timeSec * fps) } : p);
    pPointsRef.current = update(pPointsRef.current);
    setPPoints(update);
    playerRef.current?.seekTo(timeSec);
  }, []);

  /** マーカードラッグ確定: そのP点のフレーム写真を再取得 */
  const handleMarkerDragEnd = useCallback(async (id: PPointId, timeSec: number) => {
    handleMarkerDrag(id, timeSec);
    setActivePId(id);
    const video = playerRef.current?.getVideoElement();
    if (!video) return;
    const url = await extractFrameAt(video, timeSec);
    setPFrames(prev => prev.map(f => f.id === id ? { ...f, timeSec, imageUrl: url } : f));
  }, [handleMarkerDrag]);

  /** ギャラリーのカードタップ → そのP点へシーク */
  const handleGallerySelect = useCallback((id: PPointId) => {
    const p = pPointsRef.current.find(x => x.id === id);
    if (!p) return;
    setActivePId(id);
    playerRef.current?.seekTo(p.timeSec);
  }, []);

  /** 10枚一括再切り出し */
  const handleExtractAll = useCallback(() => {
    void extractAllPFrames(pPointsRef.current);
  }, [extractAllPFrames]);

  // === タッチジェスチャー ===

  /**
   * 横ドラッグ: 指を置いた位置からの累積 px で再生位置を決定。
   * PX_PER_FRAME px = 1解析フレーム。
   */
  const handleHorizontalDrag = useCallback((totalDeltaPx: number) => {
    const dur = playerRef.current?.getDuration() ?? 0;
    if (dur === 0) return;

    // 初回ドラッグ時にベース時刻を記録
    if (dragBaseTimeRef.current < 0) {
      dragBaseTimeRef.current = playerRef.current?.getCurrentTime() ?? 0;
    }

    const frameDelta = totalDeltaPx / PX_PER_FRAME;
    const timeDelta = frameDelta / analysisFpsRef.current;
    const newTime = Math.max(0, Math.min(dur, dragBaseTimeRef.current + timeDelta));
    playerRef.current?.seekTo(newTime);
  }, []);

  const handleHorizontalDragEnd = useCallback(() => {
    // 次のドラッグ開始時にベース時刻を再設定するためのフラグ
    dragBaseTimeRef.current = -1;
  }, []);

  // 初期値を -1 にして最初の drag で currentTime を取得させる
  useEffect(() => { dragBaseTimeRef.current = -1; }, [videoSrc]);

  const handlePinchZoom = useCallback((scale: number) => {
    setZoom(prev => Math.max(0.5, Math.min(5, prev * scale)));
  }, []);

  useTouchGestures(viewportRef, {
    onHorizontalDrag: handleHorizontalDrag,
    onHorizontalDragEnd: handleHorizontalDragEnd,
    onPinchZoom: handlePinchZoom,
  });

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
      </nav>

      {/* ========== クラブ設定ビュー ========== */}
      {view === 'clubs' && <ClubManager />}

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
                    : batchStage === 'pose'
                      ? `全フレーム解析中... ${batchProgress}%`
                      : `P点フレーム切り出し中... ${batchProgress}%`}
                </span>
                {state === 'batch-analyzing' && (
                  <div className="batch-progress-bar">
                    <div className="batch-progress-fill" style={{ width: `${batchProgress}%` }} />
                  </div>
                )}
              </div>
            )}

            {/* ビューポート */}
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
                {/* フェーズタイムライン */}
                <canvas ref={phaseCanvasRef} className="phase-timeline-canvas" />
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

            {/* P点タイムライン（ビデオ編集風マーカースライダー） */}
            <PPointTimeline
              pPoints={pPoints}
              duration={duration}
              currentTime={currentTime}
              onSeek={(t) => playerRef.current?.seekTo(t)}
              onMarkerDrag={handleMarkerDrag}
              onMarkerDragEnd={handleMarkerDragEnd}
              disabled={state !== 'ready' || extracting}
            />

            {/* ミニツールバー */}
            <div className="mini-toolbar">
              <div className="toolbar-row">
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
                <label className="toggle-chip">
                  <input type="checkbox" checked={showPhase} onChange={(e) => setShowPhase(e.target.checked)} />
                  フェーズ
                </label>

                <span className="separator" />

                <button className="icon-btn" onClick={() => handleRotation(-1)} title="左回転">↶</button>
                <span className="rotation-display">{rotation}°</span>
                <button className="icon-btn" onClick={() => handleRotation(1)} title="右回転">↷</button>

                {(zoom !== 1 || rotation !== 0) && (
                  <button className="icon-btn" onClick={handleResetTransform} title="リセット">⟲</button>
                )}

                {currentPhase !== 'unknown' && (
                  <span className="phase-chip">{getPhaseInfo(currentPhase).label}</span>
                )}
              </div>

              <div className="toolbar-row">
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
                    allPhasesRef.current = [];
                    pPointsRef.current = [];
                    setPPoints([]);
                    setPFrames([]);
                    setActivePId(null);
                  }}
                >
                  別の動画を選択
                </button>
                {state === 'ready' && (
                  <button className="btn-upload-new" onClick={batchAnalyze}>
                    再解析
                  </button>
                )}
                <span className="hint-text">
                  横ドラッグでコマ送り ・ ピンチでズーム
                </span>
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
