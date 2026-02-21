import { useRef, useCallback, useEffect, useState, forwardRef, useImperativeHandle } from 'react';

export interface VideoPlayerHandle {
  getVideoElement: () => HTMLVideoElement | null;
  getVideoDimensions: () => { width: number; height: number };
}

interface VideoPlayerProps {
  src: string | null;
  onReady?: (video: HTMLVideoElement) => void;
  onPlay?: () => void;
  onPause?: () => void;
  onSeeked?: () => void;
  onTimeUpdate?: (currentTime: number) => void;
}

/**
 * 動画再生コンポーネント
 * 再生/一時停止、シーク、コマ送り、速度変更に対応
 */
const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(
  ({ src, onReady, onPlay, onPause, onSeeked, onTimeUpdate }, ref) => {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const [playing, setPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [speed, setSpeed] = useState(1);
    const [dimensions, setDimensions] = useState({ width: 640, height: 480 });

    useImperativeHandle(ref, () => ({
      getVideoElement() {
        return videoRef.current;
      },
      getVideoDimensions() {
        return dimensions;
      },
    }));

    // 動画メタデータ読み込み
    const handleLoadedMetadata = useCallback(() => {
      const video = videoRef.current;
      if (!video) return;
      setDuration(video.duration);
      setDimensions({
        width: video.videoWidth,
        height: video.videoHeight,
      });
      onReady?.(video);
    }, [onReady]);

    // 時間更新
    const handleTimeUpdate = useCallback(() => {
      const video = videoRef.current;
      if (!video) return;
      setCurrentTime(video.currentTime);
      onTimeUpdate?.(video.currentTime);
    }, [onTimeUpdate]);

    // 再生/一時停止のトグル
    const togglePlay = useCallback(() => {
      const video = videoRef.current;
      if (!video) return;
      if (video.paused) {
        video.play();
      } else {
        video.pause();
      }
    }, []);

    // コマ送り（前/次）
    const stepFrame = useCallback((direction: 1 | -1) => {
      const video = videoRef.current;
      if (!video) return;
      video.pause();
      // 約 30fps 想定で 1フレーム ≈ 1/30秒
      const frameTime = 1 / 30;
      video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + direction * frameTime));
    }, []);

    // 速度変更
    const changeSpeed = useCallback((newSpeed: number) => {
      const video = videoRef.current;
      if (!video) return;
      video.playbackRate = newSpeed;
      setSpeed(newSpeed);
    }, []);

    // シーク
    const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      const video = videoRef.current;
      if (!video) return;
      video.currentTime = parseFloat(e.target.value);
    }, []);

    // イベントリスナー設定
    useEffect(() => {
      const video = videoRef.current;
      if (!video) return;

      const handlePlayEvent = () => { setPlaying(true); onPlay?.(); };
      const handlePauseEvent = () => { setPlaying(false); onPause?.(); };
      const handleSeekedEvent = () => { onSeeked?.(); };

      video.addEventListener('play', handlePlayEvent);
      video.addEventListener('pause', handlePauseEvent);
      video.addEventListener('seeked', handleSeekedEvent);

      return () => {
        video.removeEventListener('play', handlePlayEvent);
        video.removeEventListener('pause', handlePauseEvent);
        video.removeEventListener('seeked', handleSeekedEvent);
      };
    }, [onPlay, onPause, onSeeked]);

    // 時間表示フォーマット
    const formatTime = (t: number) => {
      const m = Math.floor(t / 60);
      const s = Math.floor(t % 60);
      const ms = Math.floor((t % 1) * 10);
      return `${m}:${s.toString().padStart(2, '0')}.${ms}`;
    };

    if (!src) return null;

    const speeds = [0.25, 0.5, 1, 1.5, 2];

    return (
      <div className="video-player">
        <video
          ref={videoRef}
          src={src}
          className="analysis-video"
          onLoadedMetadata={handleLoadedMetadata}
          onTimeUpdate={handleTimeUpdate}
          playsInline
          muted
        />

        <div className="player-controls">
          {/* コマ戻し */}
          <button className="ctrl-btn" onClick={() => stepFrame(-1)} title="前のフレーム">
            ⏮
          </button>

          {/* 再生/一時停止 */}
          <button className="ctrl-btn ctrl-play" onClick={togglePlay} title={playing ? '一時停止' : '再生'}>
            {playing ? '⏸' : '▶'}
          </button>

          {/* コマ送り */}
          <button className="ctrl-btn" onClick={() => stepFrame(1)} title="次のフレーム">
            ⏭
          </button>

          {/* 時間表示 */}
          <span className="time-display">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>

          {/* シークバー */}
          <input
            type="range"
            className="seek-bar"
            min={0}
            max={duration || 0}
            step={0.001}
            value={currentTime}
            onChange={handleSeek}
          />

          {/* 速度切替 */}
          <div className="speed-controls">
            {speeds.map((s) => (
              <button
                key={s}
                className={`speed-btn ${speed === s ? 'active' : ''}`}
                onClick={() => changeSpeed(s)}
              >
                {s}x
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  },
);

VideoPlayer.displayName = 'VideoPlayer';

export default VideoPlayer;
