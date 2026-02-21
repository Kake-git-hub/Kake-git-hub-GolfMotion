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

type AppState = 'idle' | 'loading-model' | 'ready' | 'analyzing' | 'error';

export default function App() {
  const [state, setState] = useState<AppState>('idle');
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [fps, setFps] = useState(0);
  const [showSkeleton, setShowSkeleton] = useState(true);
  const [showAngles, setShowAngles] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [videoDims, setVideoDims] = useState({ width: 640, height: 480 });
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0~1
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0); // 度
  const [speed, setSpeed] = useState(1);

  const playerRef = useRef<VideoPlayerHandle>(null);
  const canvasRef = useRef<SkeletonCanvasHandle>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const animFrameRef = useRef<number>(0);
  const lastFpsTime = useRef(performance.now());
  const frameCount = useRef(0);
  const isPlayingRef = useRef(false);

  // 一時停止時にキャッシュした解析結果（ブレ防止）
  const cachedPoseRef = useRef<PoseResult | null>(null);
  const seekStartTimeRef = useRef(0);

  /** drawFrame: 1フレーム分の描画 */
  const drawFrame = useCallback((poseResult: PoseResult | null) => {
    const ctx = canvasRef.current?.getContext();
    if (!ctx) return;
    const { width, height } = videoDims;
    ctx.clearRect(0, 0, width, height);

    if (showGrid) {
      drawGrid(ctx, width, height);
    }

    if (poseResult) {
      if (showSkeleton) {
        drawSkeleton(ctx, poseResult.landmarks, width, height);
      }
      if (showAngles) {
        const angles = calculateAngles(poseResult.landmarks);
        drawAngles(ctx, angles, width, height);
      }
    }
  }, [videoDims, showSkeleton, showAngles, showGrid]);

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

  /** 検出＋描画ループ（再生中のみ） */
  const analysisLoop = useCallback(() => {
    const video = playerRef.current?.getVideoElement();
    if (video && video.readyState >= 2) {
      const result = detectPose(video);
      if (result) {
        cachedPoseRef.current = result;
      }
      drawFrame(cachedPoseRef.current);

      // FPS
      frameCount.current++;
      const now = performance.now();
      if (now - lastFpsTime.current >= 1000) {
        setFps(frameCount.current);
        frameCount.current = 0;
        lastFpsTime.current = now;
      }
    }
    animFrameRef.current = requestAnimationFrame(analysisLoop);
  }, [drawFrame]);

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

  /** 動画メタデータ読み込み完了時 */
  const handleVideoReady = useCallback(async (video: HTMLVideoElement) => {
    setVideoDims({ width: video.videoWidth, height: video.videoHeight });
    await loadModel();
  }, [loadModel]);

  const handlePlay = useCallback(() => {
    isPlayingRef.current = true;
    setPlaying(true);
    setState('analyzing');
    cancelAnimationFrame(animFrameRef.current);
    animFrameRef.current = requestAnimationFrame(analysisLoop);
  }, [analysisLoop]);

  const handlePause = useCallback(() => {
    isPlayingRef.current = false;
    setPlaying(false);
    setState('ready');
    cancelAnimationFrame(animFrameRef.current);
    // 一時停止時にキャッシュデータで一度描画（ブレ防止）
    drawFrame(cachedPoseRef.current);
  }, [drawFrame]);

  /** シーク完了時（一時停止中でも1フレーム解析してキャッシュ）*/
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
      cancelAnimationFrame(animFrameRef.current);
      disposePoseDetector();
      if (videoSrc) URL.revokeObjectURL(videoSrc);
    };
  }, [videoSrc]);

  // 表示設定変更時、再生中ならループ更新
  useEffect(() => {
    if (isPlayingRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = requestAnimationFrame(analysisLoop);
    } else {
      // 停止中でもグリッド等は即反映
      drawFrame(cachedPoseRef.current);
    }
  }, [analysisLoop, drawFrame]);

  // === タッチジェスチャー ===
  const handleTap = useCallback(() => {
    playerRef.current?.togglePlay();
  }, []);

  const handleHorizontalSwipe = useCallback((deltaRatio: number) => {
    const dur = playerRef.current?.getDuration() ?? 0;
    if (dur === 0) return;
    // 画面幅いっぱいスワイプ = 動画全体の20%に相当
    if (!seekStartTimeRef.current) {
      seekStartTimeRef.current = playerRef.current?.getCurrentTime() ?? 0;
    }
    const seekDelta = deltaRatio * dur * 0.2;
    const newTime = Math.max(0, Math.min(dur, seekStartTimeRef.current + seekDelta));
    playerRef.current?.seekTo(newTime);
  }, []);

  const handlePinchZoom = useCallback((scale: number) => {
    setZoom(prev => {
      const next = prev * scale;
      return Math.max(1, Math.min(5, next));
    });
  }, []);

  useTouchGestures(viewportRef, {
    onTap: handleTap,
    onHorizontalSwipe: handleHorizontalSwipe,
    onPinchZoom: handlePinchZoom,
  });

  // マウスクリックで再生/一時停止 (PC用)
  const handleViewportClick = useCallback((e: React.MouseEvent) => {
    // ツールバー等のボタンからの伝播は無視
    if ((e.target as HTMLElement).closest('.settings-panel, .seek-progress-bar, .mini-toolbar')) return;
    playerRef.current?.togglePlay();
  }, []);

  // seekStart タイムスタンプリセット（touchend で呼ばれる）
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const resetSeek = () => { seekStartTimeRef.current = 0; };
    el.addEventListener('touchend', resetSeek);
    return () => el.removeEventListener('touchend', resetSeek);
  }, []);

  // 速度変更
  const handleSpeedChange = useCallback((s: number) => {
    setSpeed(s);
    playerRef.current?.setSpeed(s);
  }, []);

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
            onClick={handleViewportClick}
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
                onPlay={handlePlay}
                onPause={handlePause}
                onSeeked={handleSeeked}
                onTimeUpdate={handleTimeUpdate}
              />
              <SkeletonCanvas
                ref={canvasRef}
                width={videoDims.width}
                height={videoDims.height}
              />
            </div>

            {/* 再生/一時停止 インジケーター */}
            {!playing && state !== 'loading-model' && state !== 'idle' && (
              <div className="play-indicator">▶</div>
            )}

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

              {/* 速度 */}
              <div className="speed-chips">
                {[0.25, 0.5, 1].map((s) => (
                  <button
                    key={s}
                    className={`speed-chip ${speed === s ? 'active' : ''}`}
                    onClick={() => handleSpeedChange(s)}
                  >
                    {s}x
                  </button>
                ))}
              </div>

              <span className="separator" />

              {/* 回転 */}
              <button className="icon-btn" onClick={() => handleRotation(-1)} title="左に1度回転">↶</button>
              <span className="rotation-display">{rotation}°</span>
              <button className="icon-btn" onClick={() => handleRotation(1)} title="右に1度回転">↷</button>

              {zoom > 1 && (
                <button className="icon-btn" onClick={handleResetTransform} title="リセット">⟲</button>
              )}

              {state === 'analyzing' && (
                <span className="fps-chip">{fps} FPS</span>
              )}
            </div>

            <div className="toolbar-row">
              <button
                className="btn-upload-new"
                onClick={() => {
                  cancelAnimationFrame(animFrameRef.current);
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
                タップで再生/停止 ・ 横スワイプでシーク
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
