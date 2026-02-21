import { useRef, useCallback, useEffect } from 'react';

interface TouchGestureOptions {
  /**
   * 横ドラッグ: タッチ開始位置からの累積ピクセル差分を通知。
   * 呼び出し側で「何フレーム送るか」を決める。
   */
  onHorizontalDrag?: (totalDeltaPx: number) => void;
  /** ドラッグ終了通知（指を離した時） */
  onHorizontalDragEnd?: () => void;
  /** ピンチズーム: 増分スケール (1.0 = 変化なし) */
  onPinchZoom?: (incrementalScale: number) => void;
}

/**
 * タッチジェスチャーフック（v3 — ピンチ修正 + 1FPS フレーム送り対応）
 *
 * タッチモデル:
 *   1本指横ドラッグ → onHorizontalDrag(タッチ開始位置からの累積px)
 *   2本指ピンチ     → onPinchZoom(前回距離との比率)
 *
 * ピンチ実装:
 *   - touchstart(2本) で基準距離を記録
 *   - touchmove で「前回距離 / 今回距離」の比率を増分スケールとして送出
 *   - touchend(1本以下に戻った) でピンチ終了
 *   - ブラウザデフォルトのピンチ拡大を全面ブロック
 */
export function useTouchGestures(
  elementRef: React.RefObject<HTMLElement | null>,
  options: TouchGestureOptions,
) {
  const optsRef = useRef(options);
  optsRef.current = options;

  // --- ピンチ状態 ---
  const pinchRef = useRef({
    active: false,
    lastDist: 0,
  });

  // --- 1本指ドラッグ状態 ---
  const dragRef = useRef({
    active: false,
    startX: 0,
  });

  const dist = useCallback((a: Touch, b: Touch) => {
    const dx = a.clientX - b.clientX;
    const dy = a.clientY - b.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }, []);

  useEffect(() => {
    const el = elementRef.current;
    if (!el) return;

    // ================================================================
    //  タッチ
    // ================================================================
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length >= 2) {
        // === ピンチ開始 ===
        dragRef.current.active = false;            // ドラッグは解除
        pinchRef.current.active = true;
        pinchRef.current.lastDist = dist(e.touches[0], e.touches[1]);
        e.preventDefault();
        return;
      }

      if (e.touches.length === 1 && !pinchRef.current.active) {
        // === ドラッグ開始 ===
        dragRef.current.active = true;
        dragRef.current.startX = e.touches[0].clientX;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      // --- ピンチ ---
      if (e.touches.length >= 2 && pinchRef.current.active) {
        const d = dist(e.touches[0], e.touches[1]);
        const last = pinchRef.current.lastDist;
        if (last > 10) {                           // ゼロ除算ガード
          const scale = d / last;
          optsRef.current.onPinchZoom?.(scale);
        }
        pinchRef.current.lastDist = d;
        e.preventDefault();
        return;
      }

      // --- 横ドラッグ ---
      if (e.touches.length === 1 && dragRef.current.active) {
        const curX = e.touches[0].clientX;
        const totalDelta = curX - dragRef.current.startX;
        optsRef.current.onHorizontalDrag?.(totalDelta);
        e.preventDefault();
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (pinchRef.current.active) {
        if (e.touches.length < 2) {
          pinchRef.current.active = false;
          pinchRef.current.lastDist = 0;
        }
        return;
      }

      if (dragRef.current.active) {
        dragRef.current.active = false;
        optsRef.current.onHorizontalDragEnd?.();
      }
    };

    // ================================================================
    //  ブラウザ組み込みジェスチャーの無効化
    // ================================================================
    const onGestureStart = (e: Event) => e.preventDefault();
    const onGestureChange = (e: Event) => e.preventDefault();

    // ================================================================
    //  マウスホイールズーム (PC)
    // ================================================================
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const s = e.deltaY > 0 ? 0.92 : 1.08;
        optsRef.current.onPinchZoom?.(s);
      }
    };

    // ================================================================
    //  マウスドラッグ (PC)
    // ================================================================
    let mouseDown = false;
    let mouseStartX = 0;
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      mouseDown = true;
      mouseStartX = e.clientX;
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!mouseDown) return;
      const totalDelta = e.clientX - mouseStartX;
      optsRef.current.onHorizontalDrag?.(totalDelta);
    };
    const onMouseUp = () => {
      if (mouseDown) {
        mouseDown = false;
        optsRef.current.onHorizontalDragEnd?.();
      }
    };

    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);
    el.addEventListener('gesturestart', onGestureStart);
    el.addEventListener('gesturechange', onGestureChange);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('mousedown', onMouseDown);
    el.addEventListener('mousemove', onMouseMove);
    el.addEventListener('mouseup', onMouseUp);
    el.addEventListener('mouseleave', onMouseUp);

    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGestureChange);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('mousedown', onMouseDown);
      el.removeEventListener('mousemove', onMouseMove);
      el.removeEventListener('mouseup', onMouseUp);
      el.removeEventListener('mouseleave', onMouseUp);
    };
  }, [elementRef, dist]);
}
