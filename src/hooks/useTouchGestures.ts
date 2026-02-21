import { useRef, useCallback, useEffect } from 'react';

interface TouchGestureOptions {
  onTap?: () => void;
  onHorizontalSwipe?: (deltaRatio: number) => void;  // -1~+1 のビューポート割合
  onPinchZoom?: (scale: number, centerX: number, centerY: number) => void;
  onPan?: (dx: number, dy: number) => void;
}

/**
 * タッチジェスチャーフック
 * - シングルタップ: 再生/一時停止
 * - 横スワイプ: シーク
 * - ピンチ: ズーム
 * - 2本指パン: ズーム時の移動
 */
export function useTouchGestures(
  elementRef: React.RefObject<HTMLElement | null>,
  options: TouchGestureOptions,
) {
  const optsRef = useRef(options);
  optsRef.current = options;

  const stateRef = useRef({
    startX: 0,
    startY: 0,
    startTime: 0,
    moved: false,
    isSeeking: false,
    initialPinchDist: 0,
    initialScale: 1,
    isPinching: false,
  });

  const getTouchDistance = useCallback((t1: Touch, t2: Touch) => {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }, []);

  useEffect(() => {
    const el = elementRef.current;
    if (!el) return;

    const handleTouchStart = (e: TouchEvent) => {
      const s = stateRef.current;

      if (e.touches.length === 2) {
        // ピンチ開始
        s.isPinching = true;
        s.isSeeking = false;
        s.initialPinchDist = getTouchDistance(e.touches[0], e.touches[1]);
        e.preventDefault();
        return;
      }

      if (e.touches.length === 1) {
        s.startX = e.touches[0].clientX;
        s.startY = e.touches[0].clientY;
        s.startTime = Date.now();
        s.moved = false;
        s.isSeeking = false;
        s.isPinching = false;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      const s = stateRef.current;

      if (e.touches.length === 2 && s.isPinching) {
        const dist = getTouchDistance(e.touches[0], e.touches[1]);
        const scale = dist / s.initialPinchDist;
        const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        optsRef.current.onPinchZoom?.(scale, cx, cy);
        e.preventDefault();
        return;
      }

      if (e.touches.length === 1 && !s.isPinching) {
        const dx = e.touches[0].clientX - s.startX;
        const dy = e.touches[0].clientY - s.startY;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);

        // 横方向の移動がある程度あれば seek
        if (absDx > 10 && absDx > absDy * 1.5) {
          s.moved = true;
          s.isSeeking = true;
          const rect = el.getBoundingClientRect();
          const ratio = dx / rect.width;
          optsRef.current.onHorizontalSwipe?.(ratio);
          e.preventDefault();
        } else if (absDx > 10 || absDy > 10) {
          s.moved = true;
        }
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      const s = stateRef.current;

      if (s.isPinching) {
        if (e.touches.length < 2) {
          s.isPinching = false;
        }
        return;
      }

      if (!s.moved && !s.isSeeking) {
        const elapsed = Date.now() - s.startTime;
        if (elapsed < 300) {
          optsRef.current.onTap?.();
        }
      }

      s.isSeeking = false;
      s.moved = false;
    };

    // マウスホイールでのズーム (PC 用)
    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        optsRef.current.onPinchZoom?.(delta, e.clientX, e.clientY);
      }
    };

    el.addEventListener('touchstart', handleTouchStart, { passive: false });
    el.addEventListener('touchmove', handleTouchMove, { passive: false });
    el.addEventListener('touchend', handleTouchEnd);
    el.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchmove', handleTouchMove);
      el.removeEventListener('touchend', handleTouchEnd);
      el.removeEventListener('wheel', handleWheel);
    };
  }, [elementRef, getTouchDistance]);
}
