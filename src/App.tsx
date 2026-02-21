import { useState, useRef, useCallback, useEffect } from 'react';
import VideoUploader from './components/VideoUploader';
import VideoPlayer, { type VideoPlayerHandle } from './components/VideoPlayer';
import SkeletonCanvas, { type SkeletonCanvasHandle } from './components/SkeletonCanvas';
import { initPoseDetector, detectPose, disposePoseDetector, isPoseDetectorReady, type PoseResult } from './services/poseDetector';
import { drawSkeleton } from './services/skeletonRenderer';
import { calculateAngles, drawAngles } from './services/angleCalculator';
import { drawGrid } from './services/gridRenderer';
import { useTouchGestures } from './hooks/useTouchGestures';
import './App.css';

type AppState = 'idle' | 'loading-model' | 'ready' | 'error';

/** フレーム送りの FPS（1ステップ = 1/FPS_STEP 秒） */
const FPS_STEP = 10;
/** 1フレーム送りに必要なドラッグピクセル数 */
const PX_PER_FRAME = 15;

export default function App() {
  const [state, setState] = useState<AppState>('idle');
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [showSkeleton, setShowSkeleton] = useState(true);
  const [showAngles, setShowAngles] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [videoDims, setVideoDims] = useState({ width: 640, height: 480 });
  const [progress, setProgress] = useState(0); // 0~1
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0); // 度

  const playerRef = useRef<VideoPlayerHandle>(null);
  const canvasRef = useRef<SkeletonCanvasHandle>(null);
  const gridCanvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  // キャッシュした解析結果（ブレ防止）
  const cachedPoseRef = useRef<PoseResult | null>(null);
  const dragAccumRef = useRef(0);

  /** drawFrame: skeleton + angles (グリッドは別キャンバス) */
  const drawFrame = useCallback((poseResult: PoseResult | null) => {
    const ctx = canvasRef.current?.getContext();
    if (!ctx) return;
    const { width, height } = videoDims;
    ctx.clearRect(0, 0, width, height);

    if (poseResult) {
      if (showSkeleton) {
        drawSkeleton(ctx, poseResult.landmarks, width, height);
      }
      if (showAngles) {
        const angles = calculateAngles(poseResult.landmarks);
        drawAngles(ctx, angles, width, height);
      }
    }
  }, [videoDims, showSkeleton, showAngles]);

  /** グリッドを固定キャンバスに描画（回転・ズーム非連動） */
  const drawGridOverlay = useCallback(() => {
    const canvas = gridCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // CSS サイズに合わせてキャンバス解像度を更新
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.clearRect(0, 0, w, h);
    if (showGrid) {
      drawGrid(ctx, w, h);
    }
  }, [showGrid]);

  /** モデル初期化 */
  const loadModel = useCallback(async () => {
    if (isPoseDetectorReady()) return;
    setState('loading-model');
    try {
      await initPoseDetector();
      setState('ready');
    } catch (err) {
      console.error('Model loading failed:', err);
      setErrorMsg('ポーズ検出モデルの読み込みに失敗しました。ブラウザがWebGLに対応しているか確認してください。');
      setState('error');
    }
  }, []);

  /** 動画ファイル選択時 */
  const handleVideoSelected = useCallback((file: File) => {
    if (videoSrc) URL.revokeObjectURL(videoSrc);
    const url = URL.createObjectURL(file);
    setVideoSrc(url);
    setState('idle');
    canvasRef.current?.clear();
    cachedPoseRef.current = null;
    setZoom(1);
    setPanOffset({ x: 0, y: 0 });
    setRotation(0);
    setProgress(0);
  }, [videoSrc]);

  /** 動画メタデータ読み込み完了時（常に一時停止） */
  const handleVideoReady = useCallback(async (video: HTMLVideoElement) => {
    setVideoDims({ width: video.videoWidth, height: video.videoHeight });
    video.pause();
    await loadModel();
  }, [loadModel]);

  /** シーク完了時（1フレーム解析してキャッシュ） */
  const handleSeeked = useCallback(() => {
    const video = playerRef.current?.getVideoElement();
    if (!video || !isPoseDetectorReady()) return;

    const result = detectPose(video);
    if (result) {
      cachedPoseRef.current = result;
    }
    drawFrame(cachedPoseRef.current);
  }, [drawFrame]);

  const handleTimeUpdate = useCallback((currentTime: number, duration: number) => {
    if (duration > 0) setProgress(currentTime / duration);
  }, []);

  /** クリーンアップ */
  useEffect(() => {
    return () => {
      disposePoseDetector();
      if (videoSrc) URL.revokeObjectURL(videoSrc);
    };
  }, [videoSrc]);

  // 表示設定変更時、即反映
  useEffect(() => {
    drawFrame(cachedPoseRef.current);
  }, [drawFrame]);

  // グリッド描画（showGrid 変更時＋ウインドウリサイズ時）
  useEffect(() => {
    drawGridOverlay();
  }, [drawGridOverlay]);

  useEffect(() => {
    const handleResize = () => drawGridOverlay();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [drawGridOverlay]);

  // === タッチジェスチャー ===
  /** 横ドラッグでフレーム送り（FPS_STEP 刻み） */
  const handleHorizontalDrag = useCallback((deltaPx: number) => {
    const dur = playerRef.current?.getDuration() ?? 0;
    if (dur === 0) return;

    dragAccumRef.current += deltaPx;
    const frameStep = 1 / FPS_STEP; // 0.1 sec
    const framesAccum = Math.trunc(dragAccumRef.current / PX_PER_FRAME);
    if (framesAccum !== 0) {
      dragAccumRef.current -= framesAccum * PX_PER_FRAME;
      const curTime = playerRef.current?.getCurrentTime() ?? 0;
      const newTime = Math.max(0, Math.min(dur, curTime + framesAccum * frameStep));
      playerRef.current?.seekTo(newTime);
    }
  }, []);

  const handlePinchZoom = useCallback((scale: number) => {
    setZoom(prev => {
      const next = prev * scale;
      return Math.max(1, Math.min(5, next));
    });
  }, []);

  useTouchGestures(viewportRef, {
    onHorizontalDrag: handleHorizontalDrag,
    onPinchZoom: handlePinchZoom,
  });

  // 回転調整
  const handleRotation = useCallback((delta: number) => {
    setRotation(prev => prev + delta);
  }, []);

  // リセット
  const handleResetTransform = useCallback(() => {
    setZoom(1);
    setPanOffset({ x: 0, y: 0 });
    setRotation(0);
  }, []);

  // ビューポート表示計算
  const maxWidth = Math.min(videoDims.width, window.innerWidth);
  const maxHeight = window.innerHeight - 120; // ヘッダー+ツールバー分
  const scaleW = maxWidth / videoDims.width;
  const scaleH = maxHeight / videoDims.height;
  const baseScale = Math.min(scaleW, scaleH, 1);
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
          {/* モデルローディング */}
          {state === 'loading-model' && (
            <div className="model-loading-overlay">
              <div className="spinner" />
              <span>ポーズ検出モデルを読み込み中...</span>
            </div>
          )}

          {/* ビューポート */}
          <div
            ref={viewportRef}
            className="viewport"
            style={{ width: displayWidth, height: displayHeight }}
          >
            {/* 回転・ズーム対象: 動画 + 骨格 */}
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

            {/* グリッド: 回転・ズームに連動しない固定オーバーレイ */}
            <canvas
              ref={gridCanvasRef}
              className="grid-canvas"
            />

            {/* シークプログレスバー（常に表示、ズーム非連動） */}
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

          {/* ミニツールバー（ビューポート外・常に表示） */}
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

              <span className="separator" />

              {/* 回転 */}
              <button className="icon-btn" onClick={() => handleRotation(-1)} title="左に1度回転">↶</button>
              <span className="rotation-display">{rotation}°</span>
              <button className="icon-btn" onClick={() => handleRotation(1)} title="右に1度回転">↷</button>

              {zoom > 1 && (
                <button className="icon-btn" onClick={handleResetTransform} title="リセット">⟲</button>
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
                }}
              >
                別の動画を選択
              </button>
              <span className="hint-text">
                横スワイプでフレーム送り ・ ピンチでズーム
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
