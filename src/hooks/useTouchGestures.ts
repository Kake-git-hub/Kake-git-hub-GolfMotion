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
  /**
   * タップ通知（開始位置からの移動量が閾値未満のまま指/ボタンを離した場合）。
   * clientX/clientY はタップ位置（クライアント座標）。
   * 移動量が閾値を超えた場合は代わりに onHorizontalDrag/onHorizontalDragEnd が呼ばれる。
   */
  onTap?: (clientX: number, clientY: number) => void;
}

/** タップと判定する最大移動量 (px) */
const TAP_MOVE_THRESHOLD = 10;

/**
 * タッチジェスチャーフック（v4 — タップ判定を追加）
 *
 * タッチモデル:
 *   1本指横ドラッグ → onHorizontalDrag(タッチ開始位置からの累積px)
 *   1本指タップ     → onTap(clientX, clientY)（移動量が閾値未満の場合）
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
  /**
   * リスナー再アタッチのトリガー。
   * elementRef.current が指す DOM ノードは条件付きレンダリング（例: 動画選択後にのみ
   * マウントされる要素）で後から生成されることがあるが、useEffect の依存配列は
   * ref オブジェクト自身（常に同一）しか見ていないため、ノード生成後もエフェクトが
   * 再実行されずリスナーが一切アタッチされない問題があった。
   * ノードの有無が変わるたびに変化する値（例: 動画の src）を渡すことで、
   * マウント/アンマウントのタイミングで確実に再アタッチする。
   */
  reattachKey?: unknown,
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
    startY: 0,
    lastX: 0,
    lastY: 0,
    moved: false,
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
        // === ドラッグ/タップ開始 ===
        dragRef.current.active = true;
        dragRef.current.startX = e.touches[0].clientX;
        dragRef.current.startY = e.touches[0].clientY;
        dragRef.current.lastX = dragRef.current.startX;
        dragRef.current.lastY = dragRef.current.startY;
        dragRef.current.moved = false;
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
        const curY = e.touches[0].clientY;
        dragRef.current.lastX = curX;
        dragRef.current.lastY = curY;
        const totalDelta = curX - dragRef.current.startX;
        if (!dragRef.current.moved) {
          const dy = curY - dragRef.current.startY;
          if (Math.hypot(totalDelta, dy) > TAP_MOVE_THRESHOLD) dragRef.current.moved = true;
        }
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
        if (e.type === 'touchcancel') return;      // キャンセル時は何も発火しない
        if (dragRef.current.moved) {
          optsRef.current.onHorizontalDragEnd?.();
        } else {
          optsRef.current.onTap?.(dragRef.current.lastX, dragRef.current.lastY);
        }
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
    let mouseStartY = 0;
    let mouseLastX = 0;
    let mouseLastY = 0;
    let mouseMoved = false;
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      mouseDown = true;
      mouseStartX = e.clientX;
      mouseStartY = e.clientY;
      mouseLastX = e.clientX;
      mouseLastY = e.clientY;
      mouseMoved = false;
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!mouseDown) return;
      const totalDelta = e.clientX - mouseStartX;
      mouseLastX = e.clientX;
      mouseLastY = e.clientY;
      if (!mouseMoved) {
        const dy = e.clientY - mouseStartY;
        if (Math.hypot(totalDelta, dy) > TAP_MOVE_THRESHOLD) mouseMoved = true;
      }
      optsRef.current.onHorizontalDrag?.(totalDelta);
    };
    const onMouseUp = () => {
      if (mouseDown) {
        mouseDown = false;
        if (mouseMoved) {
          optsRef.current.onHorizontalDragEnd?.();
        } else {
          optsRef.current.onTap?.(mouseLastX, mouseLastY);
        }
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
  }, [elementRef, dist, reattachKey]);
}
