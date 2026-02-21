import { useState, useRef, useCallback, useEffect } from 'react';
import VideoUploader from './components/VideoUploader';
import VideoPlayer, { type VideoPlayerHandle } from './components/VideoPlayer';
import SkeletonCanvas, { type SkeletonCanvasHandle } from './components/SkeletonCanvas';
import { initPoseDetector, detectPose, disposePoseDetector, isPoseDetectorReady, type PoseResult } from './services/poseDetector';
import { drawSkeleton } from './services/skeletonRenderer';
import { calculateAngles, drawAngles } from './services/angleCalculator';
import { drawGrid } from './services/gridRenderer';
import { LandmarkSmoother } from './services/landmarkSmoother';
import { ConfidenceInterpolator } from './services/confidenceInterpolator';
import { SwingPhaseDetector, drawPhaseLabel, drawPhaseTimeline, type SwingPhase } from './services/swingPhaseDetector';
import { useTouchGestures } from './hooks/useTouchGestures';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import './App.css';

type AppState = 'idle' | 'loading-model' | 'ready' | 'batch-analyzing' | 'error';

/** フレーム送りの FPS（1ステップ = 1/STEP_FPS 秒） */
const STEP_FPS = 1;
/** ドラッグ何 px で 1 フレーム送り */
const PX_PER_FRAME = 30;

export default function App() {
  const [state, setState] = useState<AppState>('idle');
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [showSkeleton, setShowSkeleton] = useState(true);
  const [showAngles, setShowAngles] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [showPhase, setShowPhase] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [videoDims, setVideoDims] = useState({ width: 640, height: 480 });
  const [progress, setProgress] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  const [currentPhaseLabel, setCurrentPhaseLabel] = useState('');
  const [batchProgress, setBatchProgress] = useState(0); // 0~100

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

  // ---------- 全フレーム一括解析 ----------
  const batchAnalyze = useCallback(async () => {
    const video = playerRef.current?.getVideoElement();
    if (!video || !isPoseDetectorReady()) return;

    setState('batch-analyzing');
    const dur = video.duration;
    videoDurRef.current = dur;
    const step = 1 / STEP_FPS;
    const totalFrames = Math.floor(dur * STEP_FPS);
    const frames: (NormalizedLandmark[] | null)[] = [];

    for (let i = 0; i <= totalFrames; i++) {
      const t = Math.min(i * step, dur);
      video.currentTime = t;
      await new Promise<void>(resolve => {
        const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
        video.addEventListener('seeked', onSeeked);
      });
      const result = detectPose(video);
      frames.push(result?.landmarks ?? null);
      setBatchProgress(Math.round((i / totalFrames) * 100));
    }

    allFramesRef.current = frames;

    // スイングフェーズ検出
    const validFrames = frames.map(f => f ?? []);
    allPhasesRef.current = phaseDetectorRef.current.analyze(validFrames, STEP_FPS);

    // 先頭に戻す
    video.currentTime = 0;
    setState('ready');
    setBatchProgress(0);
  }, []);

  // ---------- curFrame から phase を引く ----------
  const getPhaseForTime = useCallback((time: number): SwingPhase => {
    const phases = allPhasesRef.current;
    if (phases.length === 0) return 'unknown';
    const idx = Math.round(time * STEP_FPS);
    return phases[Math.max(0, Math.min(idx, phases.length - 1))];
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
    smootherRef.current.reset();
    interpolatorRef.current.reset();
    setZoom(1);
    setPanOffset({ x: 0, y: 0 });
    setRotation(0);
    setProgress(0);
    setCurrentPhaseLabel('');
  }, [videoSrc]);

  // ---------- Video ready ----------
  const handleVideoReady = useCallback(async (video: HTMLVideoElement) => {
    setVideoDims({ width: video.videoWidth, height: video.videoHeight });
    video.pause();
    await loadModel();
    // 自動で全フレーム一括解析を開始
    setTimeout(() => batchAnalyze(), 100);
  }, [loadModel, batchAnalyze]);

  // ---------- Seeked ----------
  const handleSeeked = useCallback(() => {
    const video = playerRef.current?.getVideoElement();
    if (!video || !isPoseDetectorReady()) return;

    const result = detectPose(video);
    if (result) cachedPoseRef.current = result;

    const phase = getPhaseForTime(video.currentTime);
    setCurrentPhaseLabel(phase);
    drawFrame(cachedPoseRef.current, phase);
  }, [drawFrame, getPhaseForTime]);

  const handleTimeUpdate = useCallback((currentTime: number, duration: number) => {
    if (duration > 0) setProgress(currentTime / duration);
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

  useEffect(() => { drawGridOverlay(); }, [drawGridOverlay]);
  useEffect(() => { drawPhaseTimelineOverlay(); }, [drawPhaseTimelineOverlay]);

  useEffect(() => {
    const h = () => { drawGridOverlay(); drawPhaseTimelineOverlay(); };
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, [drawGridOverlay, drawPhaseTimelineOverlay]);

  // === タッチジェスチャー ===

  /**
   * 横ドラッグ: 指を置いた位置からの累積 px で再生位置を決定。
   * 1 FPS なので PX_PER_FRAME px = 1秒。
   */
  const handleHorizontalDrag = useCallback((totalDeltaPx: number) => {
    const dur = playerRef.current?.getDuration() ?? 0;
    if (dur === 0) return;

    // 初回ドラッグ時にベース時刻を記録
    if (dragBaseTimeRef.current < 0) {
      dragBaseTimeRef.current = playerRef.current?.getCurrentTime() ?? 0;
    }

    const frameDelta = totalDeltaPx / PX_PER_FRAME;
    const timeDelta = frameDelta / STEP_FPS;
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
  const maxH = window.innerHeight - 140;
  const baseScale = Math.min(maxW / videoDims.width, maxH / videoDims.height, 1);
  const displayWidth = Math.round(videoDims.width * baseScale);
  const displayHeight = Math.round(videoDims.height * baseScale);

  return (
    <div className="app">
      {/* ========== アップロード画面 ========== */}
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

      {/* ========== 解析画面 ========== */}
      {videoSrc && (
        <div className="analysis-area">
          {/* モデル / バッチ解析ローディング */}
          {(state === 'loading-model' || state === 'batch-analyzing') && (
            <div className="model-loading-overlay">
              <div className="spinner" />
              <span>
                {state === 'loading-model'
                  ? 'ポーズ検出モデルを読み込み中...'
                  : `全フレーム解析中... ${batchProgress}%`}
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

              {currentPhaseLabel && currentPhaseLabel !== 'unknown' && (
                <span className="phase-chip">{currentPhaseLabel}</span>
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
                }}
              >
                別の動画を選択
              </button>
              {state === 'ready' && allPhasesRef.current.length === 0 && (
                <button className="btn-upload-new" onClick={batchAnalyze}>
                  フェーズ再解析
                </button>
              )}
              <span className="hint-text">
                横ドラッグで1FPSフレーム送り ・ ピンチでズーム
              </span>
            </div>
          </div>
        </div>
      )}

      {state === 'error' && (
        <div className="error-banner">
          <p>{errorMsg}</p>
          <button onClick={() => { setState('idle'); setErrorMsg(''); }}>閉じる</button>
        </div>
      )}
    </div>
  );
}
