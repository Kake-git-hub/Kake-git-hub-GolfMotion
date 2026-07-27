import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type { PPoint, PPointId } from '../types/ppoint';
import { P_POINT_INFO } from '../types/ppoint';
import './ppoint.css';

export interface PPointTimelineProps {
  /** P1..P10 順 (10件)。空配列なら「解析待ち」表示 */
  pPoints: PPoint[];
  /** 動画の長さ(秒) */
  duration: number;
  /** 現在の再生位置(秒) */
  currentTime: number;
  /** トラック背景のタップ/クリック */
  onSeek: (timeSec: number) => void;
  /** マーカードラッグ中(ライブプレビュー用に高頻度で呼ばれる) */
  onMarkerDrag: (id: PPointId, timeSec: number) => void;
  /** ドラッグ確定(指を離した時) */
  onMarkerDragEnd: (id: PPointId, timeSec: number) => void;
  disabled?: boolean;
}

/** 隣接マーカーとの最小間隔(秒) */
const EPSILON = 0.01;

/** ドラッグ中の内部状態 */
interface DragState {
  id: PPointId;
  index: number;
  timeSec: number;
}

/**
 * P 点マーカースライダー
 *
 * ビデオ編集ソフトのタイムライン風に P1〜P10 を横一列に並べ、
 * 指(ポインタ)でドラッグして位置を微調整できる。
 * トラック背景のタップは通常のシーク操作になる。
 */
export default function PPointTimeline({
  pPoints,
  duration,
  currentTime,
  onSeek,
  onMarkerDrag,
  onMarkerDragEnd,
  disabled = false,
}: PPointTimelineProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  // --- rAF スロットル用 ---
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<DragState | null>(null);

  // ドラッグ中に最新のコールバックを参照するための ref
  const onMarkerDragRef = useRef(onMarkerDrag);
  onMarkerDragRef.current = onMarkerDrag;

  /** 保留中のドラッグ通知をキャンセル */
  const cancelPending = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    pendingRef.current = null;
  }, []);

  // アンマウント時に rAF を後始末
  useEffect(() => cancelPending, [cancelPending]);

  /** 秒 → トラック上の位置(%) */
  const toPercent = useCallback(
    (timeSec: number) => {
      if (!(duration > 0)) return 0;
      const pct = (timeSec / duration) * 100;
      return Math.max(0, Math.min(100, pct));
    },
    [duration],
  );

  /** ポインタの X 座標 → 動画時刻(秒) */
  const timeFromClientX = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || !(duration > 0)) return 0;
      const ratio = (clientX - rect.left) / rect.width;
      return Math.max(0, Math.min(duration, ratio * duration));
    },
    [duration],
  );

  /**
   * 隣接マーカー間に clamp する。
   * P3 は P2 と P4 を追い越せない (epsilon 0.01秒)。両端は 0 と duration。
   */
  const clampToNeighbors = useCallback(
    (index: number, timeSec: number) => {
      const prev = pPoints[index - 1];
      const next = pPoints[index + 1];
      let lo = prev ? prev.timeSec + EPSILON : 0;
      let hi = next ? next.timeSec - EPSILON : duration;
      lo = Math.max(0, lo);
      hi = Math.min(duration > 0 ? duration : 0, hi);
      // 隣接が詰まりすぎて範囲が反転した場合は下限に寄せる
      if (lo > hi) return lo;
      return Math.max(lo, Math.min(hi, timeSec));
    },
    [pPoints, duration],
  );

  /** マーカー押下: ポインタキャプチャを取得してドラッグ開始 */
  const handleMarkerPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, id: PPointId, index: number) => {
      if (disabled || !(duration > 0)) return;
      // トラック背景の onSeek を発火させない
      e.stopPropagation();
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      setDrag({ id, index, timeSec: pPoints[index].timeSec });
    },
    [disabled, duration, pPoints],
  );

  /** ドラッグ中: rAF でスロットルしつつ onMarkerDrag を通知 */
  const handleMarkerPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!drag) return;
      e.stopPropagation();
      const timeSec = clampToNeighbors(drag.index, timeFromClientX(e.clientX));
      const nextState: DragState = { ...drag, timeSec };
      setDrag(nextState);

      pendingRef.current = nextState;
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          const pending = pendingRef.current;
          pendingRef.current = null;
          if (pending) onMarkerDragRef.current(pending.id, pending.timeSec);
        });
      }
    },
    [drag, clampToNeighbors, timeFromClientX],
  );

  /** 指を離した: ドラッグ確定 */
  const handleMarkerPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!drag) return;
      e.stopPropagation();
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      cancelPending();
      const timeSec = clampToNeighbors(drag.index, timeFromClientX(e.clientX));
      setDrag(null);
      onMarkerDragEnd(drag.id, timeSec);
    },
    [drag, cancelPending, clampToNeighbors, timeFromClientX, onMarkerDragEnd],
  );

  /** トラック背景のタップ → シーク */
  const handleTrackPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (disabled || drag || !(duration > 0)) return;
      onSeek(timeFromClientX(e.clientX));
    },
    [disabled, drag, duration, onSeek, timeFromClientX],
  );

  const isEmpty = pPoints.length === 0;

  return (
    <div className={`ppt-root${disabled ? ' ppt-disabled' : ''}`}>
      <div
        ref={trackRef}
        className="ppt-track"
        onPointerDown={handleTrackPointerDown}
      >
        {/* トラックバー(下段) */}
        <div className="ppt-bar" />

        {/* 現在時刻インジケータ(白い細線) */}
        <div className="ppt-playhead" style={{ left: `${toPercent(currentTime)}%` }} />

        {isEmpty && <div className="ppt-empty">解析待ち</div>}

        {pPoints.map((p, index) => {
          const info = P_POINT_INFO[p.id];
          const dragging = drag?.id === p.id;
          const timeSec = dragging ? drag.timeSec : p.timeSec;
          // ラベルは偶数/奇数で上下2段に互い違い配置して重なりを軽減
          const rowClass = index % 2 === 0 ? 'ppt-marker--row0' : 'ppt-marker--row1';
          const style = {
            left: `${toPercent(timeSec)}%`,
            '--ppt-color': info.color,
          } as CSSProperties;

          return (
            <div
              key={p.id}
              className={`ppt-marker ${rowClass}${dragging ? ' ppt-marker--dragging' : ''}`}
              style={style}
              title={info.description}
              onPointerDown={(e) => handleMarkerPointerDown(e, p.id, index)}
              onPointerMove={handleMarkerPointerMove}
              onPointerUp={handleMarkerPointerUp}
              onPointerCancel={handleMarkerPointerUp}
            >
              <span className="ppt-marker-label">{info.short}</span>
              <span className="ppt-marker-line" />
              <span className="ppt-marker-knob" />
              {dragging && (
                <span className="ppt-marker-time">{timeSec.toFixed(2)}s</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
