import { useRef, useCallback, useEffect, forwardRef, useImperativeHandle } from 'react';

export interface VideoPlayerHandle {
  getVideoElement: () => HTMLVideoElement | null;
  getVideoDimensions: () => { width: number; height: number };
  togglePlay: () => void;
  seekTo: (time: number) => void;
  seekRelative: (deltaSec: number) => void;
  getDuration: () => number;
  getCurrentTime: () => number;
  isPlaying: () => boolean;
  setSpeed: (rate: number) => void;
}

interface VideoPlayerProps {
  src: string | null;
  onReady?: (video: HTMLVideoElement) => void;
  onPlay?: () => void;
  onPause?: () => void;
  onSeeked?: () => void;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
}

/**
 * 動画再生コンポーネント（シンプル）
 * タッチ操作は App 側で制御するため、ボタン UI なし
 */
const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(
  ({ src, onReady, onPlay, onPause, onSeeked, onTimeUpdate }, ref) => {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const dimsRef = useRef({ width: 640, height: 480 });

    // --- シークの合流 ---
    // スクラブ中は指を動かすたびに要求が来るが、動画のシークは1件ずつしか
    // 処理できない。要求をそのまま流すと処理待ちが積み上がって映像が指に
    // 追従しなくなるため、実行中は「最後の要求だけ」を保持し、完了時に
    // まとめて反映する。
    const pendingSeekRef = useRef<number | null>(null);
    const seekingRef = useRef(false);
    const seekWatchdogRef = useRef(0);

    const flushSeek = useCallback(() => {
      const v = videoRef.current;
      const target = pendingSeekRef.current;
      if (!v || target === null) return;
      pendingSeekRef.current = null;
      seekingRef.current = true;
      // 'seeked' が来ない環境で固まらないよう保険をかける
      window.clearTimeout(seekWatchdogRef.current);
      seekWatchdogRef.current = window.setTimeout(() => {
        seekingRef.current = false;
        flushSeek();
      }, 400);
      try {
        v.currentTime = target;
      } catch {
        seekingRef.current = false;
      }
    }, []);

    const requestSeek = useCallback((time: number) => {
      const v = videoRef.current;
      if (!v) return;
      const dur = Number.isFinite(v.duration) ? v.duration : 0;
      pendingSeekRef.current = Math.max(0, Math.min(dur > 0 ? dur : time, time));
      if (!seekingRef.current) flushSeek();
    }, [flushSeek]);

    useEffect(() => () => window.clearTimeout(seekWatchdogRef.current), []);

    useImperativeHandle(ref, () => ({
      getVideoElement() {
        return videoRef.current;
      },
      getVideoDimensions() {
        return dimsRef.current;
      },
      togglePlay() {
        const v = videoRef.current;
        if (!v) return;
        if (v.paused) {
          void v.play();
        } else {
          v.pause();
        }
      },
      seekTo(time: number) {
        requestSeek(time);
      },
      seekRelative(delta: number) {
        const v = videoRef.current;
        if (!v) return;
        requestSeek((pendingSeekRef.current ?? v.currentTime) + delta);
      },
      getDuration() {
        return videoRef.current?.duration ?? 0;
      },
      getCurrentTime() {
        return videoRef.current?.currentTime ?? 0;
      },
      isPlaying() {
        return videoRef.current ? !videoRef.current.paused : false;
      },
      setSpeed(rate: number) {
        const v = videoRef.current;
        if (v) v.playbackRate = rate;
      },
    }));

    const handleLoadedMetadata = useCallback(() => {
      const v = videoRef.current;
      if (!v) return;
      dimsRef.current = { width: v.videoWidth, height: v.videoHeight };
      onReady?.(v);
    }, [onReady]);

    const handleTimeUpdate = useCallback(() => {
      const v = videoRef.current;
      if (!v) return;
      onTimeUpdate?.(v.currentTime, v.duration);
    }, [onTimeUpdate]);

    useEffect(() => {
      const v = videoRef.current;
      if (!v) return;
      const onP = () => onPlay?.();
      const onPa = () => onPause?.();
      const onS = () => {
        // 完了したので、待たせていた最新の要求を流す
        window.clearTimeout(seekWatchdogRef.current);
        seekingRef.current = false;
        flushSeek();
        onSeeked?.();
      };
      v.addEventListener('play', onP);
      v.addEventListener('pause', onPa);
      v.addEventListener('seeked', onS);
      return () => {
        v.removeEventListener('play', onP);
        v.removeEventListener('pause', onPa);
        v.removeEventListener('seeked', onS);
      };
    }, [onPlay, onPause, onSeeked, flushSeek]);

    if (!src) return null;

    return (
      <video
        ref={videoRef}
        src={src}
        className="analysis-video"
        onLoadedMetadata={handleLoadedMetadata}
        onTimeUpdate={handleTimeUpdate}
        playsInline
        muted
      />
    );
  },
);

VideoPlayer.displayName = 'VideoPlayer';

export default VideoPlayer;
