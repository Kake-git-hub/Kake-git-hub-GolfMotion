import type { CSSProperties } from 'react';
import type { PPointFrame, PPointId } from '../types/ppoint';
import { P_POINT_INFO } from '../types/ppoint';
import './ppoint.css';

export interface PPointGalleryProps {
  /** P1..P10 順 (10件)。空配列ならコンポーネント自体を非表示 */
  frames: PPointFrame[];
  /** 現在の再生位置に対応する P 点(ハイライト) */
  activeId: PPointId | null;
  /** 切り出し処理中 */
  extracting: boolean;
  /** カードタップ → その時刻へシーク */
  onSelect: (id: PPointId) => void;
  /** 「再切り出し」ボタン */
  onExtractAll: () => void;
}

/**
 * P システム分解写真ギャラリー
 *
 * 自動切り出しした 10 枚のフレームをグリッド表示する。
 * カードをタップするとその P 点の時刻へシークする。
 */
export default function PPointGallery({
  frames,
  activeId,
  extracting,
  onSelect,
  onExtractAll,
}: PPointGalleryProps) {
  // フレーム未取得なら何も描画しない
  if (frames.length === 0) return null;

  return (
    <div className="ppg-root">
      {/* ヘッダー行 */}
      <div className="ppg-header">
        <span className="ppg-title">P システム分解写真</span>
        <button
          type="button"
          className="ppg-extract-btn"
          onClick={onExtractAll}
          disabled={extracting}
        >
          {extracting ? '切り出し中...' : '📸 再切り出し'}
        </button>
      </div>

      {/* グリッド (デスクトップ5列×2行 / スマホ2列) */}
      <div className="ppg-grid">
        {frames.map((frame) => {
          const info = P_POINT_INFO[frame.id];
          const active = activeId === frame.id;
          const style = { '--ppg-color': info.color } as CSSProperties;

          return (
            <button
              type="button"
              key={frame.id}
              className={`ppg-card${active ? ' ppg-card--active' : ''}`}
              style={style}
              title={info.description}
              onClick={() => onSelect(frame.id)}
            >
              <div className="ppg-thumb">
                {frame.imageUrl ? (
                  <img
                    className="ppg-thumb-img"
                    src={frame.imageUrl}
                    alt={info.label}
                    draggable={false}
                  />
                ) : (
                  <span className="ppg-thumb-placeholder">未取得</span>
                )}
              </div>
              <div className="ppg-meta">
                <span className="ppg-label">{info.label}</span>
                <span className="ppg-time">{frame.timeSec.toFixed(2)}s</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
