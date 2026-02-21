import { useState, useRef, useCallback, useEffect } from 'react';
import VideoUploader from './components/VideoUploader';
import VideoPlayer, { type VideoPlayerHandle } from './components/VideoPlayer';
import SkeletonCanvas, { type SkeletonCanvasHandle } from './components/SkeletonCanvas';
import { initPoseDetector, detectPose, disposePoseDetector, isPoseDetectorReady } from './services/poseDetector';
import { drawSkeleton } from './services/skeletonRenderer';
import { calculateAngles, drawAngles } from './services/angleCalculator';
import './App.css';

type AppState = 'idle' | 'loading-model' | 'ready' | 'analyzing' | 'error';

export default function App() {
  const [state, setState] = useState<AppState>('idle');
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [fps, setFps] = useState(0);
  const [showSkeleton, setShowSkeleton] = useState(true);
  const [showAngles, setShowAngles] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [videoDims, setVideoDims] = useState({ width: 640, height: 480 });

  const playerRef = useRef<VideoPlayerHandle>(null);
  const canvasRef = useRef<SkeletonCanvasHandle>(null);
  const animFrameRef = useRef<number>(0);
  const lastFpsTime = useRef(performance.now());
  const frameCount = useRef(0);
  const isPlaying = useRef(false);

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

  /** 検出＋描画ループ */
  const analysisLoop = useCallback(() => {
    const video = playerRef.current?.getVideoElement();
    const ctx = canvasRef.current?.getContext();

    if (video && ctx && video.readyState >= 2) {
      const { width, height } = videoDims;
      ctx.clearRect(0, 0, width, height);

      if (showSkeleton || showAngles) {
        const result = detectPose(video);

        if (result) {
          if (showSkeleton) {
            drawSkeleton(ctx, result.landmarks, width, height);
          }
          if (showAngles) {
            const angles = calculateAngles(result.landmarks);
            drawAngles(ctx, angles, width, height);
          }
        }
      }

      // FPS カウント
      frameCount.current++;
      const now = performance.now();
      if (now - lastFpsTime.current >= 1000) {
        setFps(frameCount.current);
        frameCount.current = 0;
        lastFpsTime.current = now;
      }
    }

    animFrameRef.current = requestAnimationFrame(analysisLoop);
  }, [videoDims, showSkeleton, showAngles]);

  /** 動画ファイル選択時 */
  const handleVideoSelected = useCallback((file: File) => {
    // 前の動画のURLを解放
    if (videoSrc) URL.revokeObjectURL(videoSrc);
    const url = URL.createObjectURL(file);
    setVideoSrc(url);
    setState('idle');
    canvasRef.current?.clear();
  }, [videoSrc]);

  /** 動画メタデータ読み込み完了時 */
  const handleVideoReady = useCallback(async (video: HTMLVideoElement) => {
    setVideoDims({
      width: video.videoWidth,
      height: video.videoHeight,
    });
    await loadModel();
  }, [loadModel]);

  /** 再生開始時にループ開始 */
  const handlePlay = useCallback(() => {
    isPlaying.current = true;
    setState('analyzing');
    cancelAnimationFrame(animFrameRef.current);
    animFrameRef.current = requestAnimationFrame(analysisLoop);
  }, [analysisLoop]);

  /** 一時停止時 */
  const handlePause = useCallback(() => {
    isPlaying.current = false;
    setState('ready');
  }, []);

  /** シーク完了時（一時停止中でも1フレーム解析）*/
  const handleSeeked = useCallback(() => {
    const video = playerRef.current?.getVideoElement();
    const ctx = canvasRef.current?.getContext();
    if (!video || !ctx || !isPoseDetectorReady()) return;

    const { width, height } = videoDims;
    ctx.clearRect(0, 0, width, height);

    const result = detectPose(video);
    if (result) {
      if (showSkeleton) {
        drawSkeleton(ctx, result.landmarks, width, height);
      }
      if (showAngles) {
        const angles = calculateAngles(result.landmarks);
        drawAngles(ctx, angles, width, height);
      }
    }
  }, [videoDims, showSkeleton, showAngles]);

  /** クリーンアップ */
  useEffect(() => {
    return () => {
      cancelAnimationFrame(animFrameRef.current);
      disposePoseDetector();
      if (videoSrc) URL.revokeObjectURL(videoSrc);
    };
  }, [videoSrc]);

  // 解析ループの更新（表示設定変更時）
  useEffect(() => {
    if (isPlaying.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = requestAnimationFrame(analysisLoop);
    }
  }, [analysisLoop]);

  // ビューポートサイズ（動画のアスペクト比に合わせ、最大幅を制限）
  const maxWidth = Math.min(videoDims.width, window.innerWidth - 32);
  const scale = maxWidth / videoDims.width;
  const displayWidth = Math.round(videoDims.width * scale);
  const displayHeight = Math.round(videoDims.height * scale);

  return (
    <div className="app">
      <header className="app-header">
        <h1>🏌️ ゴルフスイング モーション解析</h1>
        {state === 'loading-model' && (
          <div className="model-loading">
            <div className="spinner" />
            <span>ポーズ検出モデルを読み込み中...</span>
          </div>
        )}
      </header>

      {!videoSrc && (
        <VideoUploader
          onVideoSelected={handleVideoSelected}
          disabled={state === 'loading-model'}
        />
      )}

      {videoSrc && (
        <div className="analysis-area">
          <div
            className="viewport"
            style={{ width: displayWidth, height: displayHeight }}
          >
            <VideoPlayer
              ref={playerRef}
              src={videoSrc}
              onReady={handleVideoReady}
              onPlay={handlePlay}
              onPause={handlePause}
              onSeeked={handleSeeked}
            />
            <SkeletonCanvas
              ref={canvasRef}
              width={videoDims.width}
              height={videoDims.height}
            />
          </div>

          <div className="toolbar">
            <label className="toggle-label">
              <input
                type="checkbox"
                checked={showSkeleton}
                onChange={(e) => setShowSkeleton(e.target.checked)}
              />
              骨格表示
            </label>
            <label className="toggle-label">
              <input
                type="checkbox"
                checked={showAngles}
                onChange={(e) => setShowAngles(e.target.checked)}
              />
              角度表示
            </label>

            <span className="fps-display">
              {state === 'analyzing' && `${fps} FPS`}
            </span>

            <button
              className="btn-upload-new"
              onClick={() => {
                cancelAnimationFrame(animFrameRef.current);
                canvasRef.current?.clear();
                if (videoSrc) URL.revokeObjectURL(videoSrc);
                setVideoSrc(null);
                setState('idle');
              }}
            >
              別の動画を選択
            </button>
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
