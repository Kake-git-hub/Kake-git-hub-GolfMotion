import { useCallback, useRef } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { P_POINT_INFO, type PPoint, type PPointId } from '../types/ppoint';
import './ppoint.css';

/** フィルムストリップに並べる 1 コマ */
export interface FilmstripThumb {
  timeSec: number;
  url: string;
}

export interface PPointFilmstripProps {
  /** スイング区間から等間隔に切り出したコマ画像（時刻昇順） */
  thumbs: FilmstripThumb[];
  /** 帯の左端が示す時刻(秒) */
  windowStart: number;
  /** 帯の右端が示す時刻(秒) */
  windowEnd: number;
  /** 現在の再生位置(秒) */
  currentTime: number;
  /** P1..P10 (10件)。空なら解析待ち表示 */
  pPoints: PPoint[];
  /** 編集対象として選択中の P 点。null なら未選択 */
  selectedId: PPointId | null;
  /** 帯のドラッグ/タップで時刻が変わった */
  onScrub: (timeSec: number) => void;
  /** ドラッグ確定（指を離した） */
  onScrubEnd?: () => void;
  /** P 点チップのタップ（同じ ID なら選択解除の意図で null が渡る） */
  onSelectP: (id: PPointId | null) => void;
  disabled?: boolean;
}

/**
 * P 点フィルムストリップ
 *
 * iPhone 写真アプリの連続写真ピッカーのように、スイング区間のコマを
 * 横一列に並べて指でなぞりながら 1 枚を選ぶ UI。
 *
 * 動画全体ではなく「スイング区間だけ」を帯の全幅に引き伸ばすため、
 * 密集しがちな P5〜P7 付近も十分に離れて表示される。
 */
export default function PPointFilmstrip({
  thumbs,
  windowStart,
  windowEnd,
  currentTime,
  pPoints,
  selectedId,
  onScrub,
  onScrubEnd,
  onSelectP,
  disabled = false,
}: PPointFilmstripProps) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const span = Math.max(windowEnd - windowStart, 0.001);

  /** 時刻 → 帯上の位置(%) */
  const toPercent = useCallback(
    (timeSec: number) => {
      const pct = ((timeSec - windowStart) / span) * 100;
      return Math.max(0, Math.min(100, pct));
    },
    [windowStart, span],
  );

  /** ポインタの X 座標 → 時刻(秒) */
  const timeFromClientX = useCallback(
    (clientX: number) => {
      const rect = stripRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return windowStart;
      const ratio = (clientX - rect.left) / rect.width;
      return windowStart + Math.max(0, Math.min(1, ratio)) * span;
    },
    [windowStart, span],
  );

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (disabled || thumbs.length === 0) return;
      e.preventDefault();
      draggingRef.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      onScrub(timeFromClientX(e.clientX));
    },
    [disabled, thumbs.length, onScrub, timeFromClientX],
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      onScrub(timeFromClientX(e.clientX));
    },
    [onScrub, timeFromClientX],
  );

  const handlePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      onScrubEnd?.();
    },
    [onScrubEnd],
  );

  // 現在時刻に最も近いコマ（選択枠の表示位置）
  const activeIndex = thumbs.length > 0
    ? thumbs.reduce(
        (best, t, i) =>
          Math.abs(t.timeSec - currentTime) < Math.abs(thumbs[best].timeSec - currentTime) ? i : best,
        0,
      )
    : -1;

  const selectedColor = selectedId ? P_POINT_INFO[selectedId].color : '#ffffff';
  const cellWidthPct = thumbs.length > 0 ? 100 / thumbs.length : 0;

  return (
    <div className={`pfs-root${disabled ? ' pfs-disabled' : ''}`}>
      {/* P 点チップ: どの P 点を編集するかを直接選ぶ */}
      <div className="pfs-chips">
        {pPoints.map((p) => {
          const info = P_POINT_INFO[p.id];
          const active = p.id === selectedId;
          const style = { '--pfs-color': info.color } as CSSProperties;
          return (
            <button
              key={p.id}
              type="button"
              className={`pfs-chip${active ? ' pfs-chip--active' : ''}`}
              style={style}
              title={info.description}
              onClick={() => onSelectP(active ? null : p.id)}
            >
              {info.short}
            </button>
          );
        })}
      </div>

      {/* コマ帯 */}
      <div
        ref={stripRef}
        className="pfs-strip"
        style={{ '--pfs-color': selectedColor } as CSSProperties}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {thumbs.length === 0 ? (
          <div className="pfs-empty">解析待ち</div>
        ) : (
          <>
            {thumbs.map((t, i) => (
              <div className="pfs-cell" key={`${t.timeSec}-${i}`}>
                <img className="pfs-cell-img" src={t.url} alt="" draggable={false} />
              </div>
            ))}

            {/* 各 P 点の位置マーカー（選択中は太く強調） */}
            {pPoints.map((p) => {
              const info = P_POINT_INFO[p.id];
              const active = p.id === selectedId;
              const style = {
                left: `${toPercent(p.timeSec)}%`,
                '--pfs-color': info.color,
              } as CSSProperties;
              return (
                <span
                  key={p.id}
                  className={`pfs-pin${active ? ' pfs-pin--active' : ''}`}
                  style={style}
                />
              );
            })}

            {/* 選択枠（iPhone 連続写真ピッカーの選択セル相当） */}
            {activeIndex >= 0 && (
              <div
                className="pfs-cursor"
                style={{ left: `${activeIndex * cellWidthPct}%`, width: `${cellWidthPct}%` }}
              />
            )}
          </>
        )}
      </div>

      {/* 現在時刻（帯の下、右寄せの控えめな表示） */}
      {thumbs.length > 0 && (
        <div className="pfs-readout">
          {selectedId && <span className="pfs-readout-label">{P_POINT_INFO[selectedId].label}</span>}
          <span className="pfs-readout-time">{currentTime.toFixed(2)}s</span>
        </div>
      )}
    </div>
  );
}
