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
        v.paused ? v.play() : v.pause();
      },
      seekTo(time: number) {
        const v = videoRef.current;
        if (!v) return;
        v.currentTime = Math.max(0, Math.min(v.duration, time));
      },
      seekRelative(delta: number) {
        const v = videoRef.current;
        if (!v) return;
        v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + delta));
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
      const onS = () => onSeeked?.();
      v.addEventListener('play', onP);
      v.addEventListener('pause', onPa);
      v.addEventListener('seeked', onS);
      return () => {
        v.removeEventListener('play', onP);
        v.removeEventListener('pause', onPa);
        v.removeEventListener('seeked', onS);
      };
    }, [onPlay, onPause, onSeeked]);

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
