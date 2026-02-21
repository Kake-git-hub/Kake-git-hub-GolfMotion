import { useRef, useCallback, useEffect } from 'react';

interface TouchGestureOptions {
  onTap?: () => void;
  /** 横スワイプ時に差分ピクセルを通知（前回 move からの増分） */
  onHorizontalDrag?: (deltaPx: number) => void;
  /** ピンチズーム時に増分スケール（1.0 = 変化なし）を通知 */
  onPinchZoom?: (incrementalScale: number) => void;
}

/**
 * タッチジェスチャーフック
 * - シングルタップ: タップ通知
 * - 横スワイプ: フレーム送り / 戻し
 * - ピンチ: ズーム（増分スケール）
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
    lastX: 0,
    startTime: 0,
    moved: false,
    isSeeking: false,
    lastPinchDist: 0,
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
        s.isPinching = true;
        s.isSeeking = false;
        s.lastPinchDist = getTouchDistance(e.touches[0], e.touches[1]);
        e.preventDefault();
        return;
      }

      if (e.touches.length === 1) {
        s.startX = e.touches[0].clientX;
        s.startY = e.touches[0].clientY;
        s.lastX = e.touches[0].clientX;
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
        if (s.lastPinchDist > 0) {
          const incrementalScale = dist / s.lastPinchDist;
          optsRef.current.onPinchZoom?.(incrementalScale);
        }
        s.lastPinchDist = dist;
        e.preventDefault();
        return;
      }

      if (e.touches.length === 1 && !s.isPinching) {
        const curX = e.touches[0].clientX;
        const dx = curX - s.startX;
        const dy = e.touches[0].clientY - s.startY;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);

        if (absDx > 8 && absDx > absDy * 1.2) {
          s.moved = true;
          s.isSeeking = true;
          // 前回位置からの増分ピクセルを通知
          const deltaPx = curX - s.lastX;
          s.lastX = curX;
          optsRef.current.onHorizontalDrag?.(deltaPx);
          e.preventDefault();
        } else if (absDx > 8 || absDy > 8) {
          s.moved = true;
        }
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      const s = stateRef.current;

      if (s.isPinching) {
        if (e.touches.length < 2) {
          s.isPinching = false;
          s.lastPinchDist = 0;
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
        optsRef.current.onPinchZoom?.(delta);
      }
    };

    // マウスドラッグでフレーム送り (PC 用)
    let mouseDown = false;
    let mouseLastX = 0;
    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      mouseDown = true;
      mouseLastX = e.clientX;
    };
    const handleMouseMove = (e: MouseEvent) => {
      if (!mouseDown) return;
      const deltaPx = e.clientX - mouseLastX;
      mouseLastX = e.clientX;
      if (Math.abs(deltaPx) > 0) {
        optsRef.current.onHorizontalDrag?.(deltaPx);
      }
    };
    const handleMouseUp = () => { mouseDown = false; };

    el.addEventListener('touchstart', handleTouchStart, { passive: false });
    el.addEventListener('touchmove', handleTouchMove, { passive: false });
    el.addEventListener('touchend', handleTouchEnd);
    el.addEventListener('wheel', handleWheel, { passive: false });
    el.addEventListener('mousedown', handleMouseDown);
    el.addEventListener('mousemove', handleMouseMove);
    el.addEventListener('mouseup', handleMouseUp);
    el.addEventListener('mouseleave', handleMouseUp);

    return () => {
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchmove', handleTouchMove);
      el.removeEventListener('touchend', handleTouchEnd);
      el.removeEventListener('wheel', handleWheel);
      el.removeEventListener('mousedown', handleMouseDown);
      el.removeEventListener('mousemove', handleMouseMove);
      el.removeEventListener('mouseup', handleMouseUp);
      el.removeEventListener('mouseleave', handleMouseUp);
    };
  }, [elementRef, getTouchDistance]);
}
