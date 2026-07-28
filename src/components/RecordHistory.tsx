import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties, JSX } from 'react';
import type { PPointId } from '../types/ppoint';
import { P_POINT_INFO } from '../types/ppoint';
import type { RecordFrame, SwingRecord } from '../types/record';
import { deleteRecord, listRecords, updateRecordNote } from '../services/recordStore';
import './recordHistory.css';

/** 一覧カードのサムネイルに出す代表 P 点 (アドレス / トップ / インパクト / フィニッシュ) */
const THUMB_IDS: PPointId[] = ['P1', 'P4', 'P7', 'P10'];

/** epoch ms → "2026/07/28 14:32" */
function formatDateTime(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '日時不明';

  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/**
 * スイング記録 (履歴) ビュー
 *
 * 「📋 記録」タブとして表示される読み取り専用コンポーネント。
 * localStorage に保存済みの骨格焼き込み静止画セットを一覧 ⇄ 詳細の 2 階層で閲覧する。
 * 動画の再解析は行わないため props は不要 (自己完結)。
 */
export default function RecordHistory(): JSX.Element {
  // マウント時に 1 度だけ localStorage から読み込む
  const [records, setRecords] = useState<SwingRecord[]>(() => listRecords());
  // 詳細ビューで開いている記録の id (null なら一覧)
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 拡大オーバーレイに表示中の画像 dataURL
  const [zoomUrl, setZoomUrl] = useState<string | null>(null);

  const selected = records.find((r) => r.id === selectedId) ?? null;

  // 削除などで選択中の記録が消えたら一覧へ戻す
  useEffect(() => {
    if (selectedId !== null && selected === null) setSelectedId(null);
  }, [selectedId, selected]);

  // 拡大中は Esc キーで閉じられるようにする
  useEffect(() => {
    if (zoomUrl === null) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoomUrl(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [zoomUrl]);

  /** 削除 (確認ダイアログ → ストア削除 → 一覧から除去) */
  const handleDelete = useCallback((record: SwingRecord) => {
    const label = `${formatDateTime(record.createdAt)} の記録`;
    if (!window.confirm(`${label}を削除しますか?\nこの操作は取り消せません。`)) return;

    deleteRecord(record.id);
    setRecords((prev) => prev.filter((r) => r.id !== record.id));
  }, []);

  /** メモ保存 (textarea の onBlur)。変更が無ければ書き込まない */
  const handleNoteBlur = useCallback((record: SwingRecord, note: string) => {
    if ((record.note ?? '') === note) return;

    updateRecordNote(record.id, note);
    setRecords((prev) => prev.map((r) => (r.id === record.id ? { ...r, note } : r)));
  }, []);

  return (
    <div className="rh-root">
      {selected === null ? (
        /* ===== 一覧ビュー ===== */
        <>
          <div className="rh-header">
            <span className="rh-title">📋 スイング記録</span>
            <span className="rh-count">{records.length} 件</span>
          </div>

          {records.length === 0 ? (
            <div className="rh-empty">
              <span className="rh-empty-icon">🗂️</span>
              <span className="rh-empty-text">まだ記録がありません</span>
              <span className="rh-empty-hint">
                解析タブで P システム分解写真を切り出したあと、記録として保存できます
              </span>
            </div>
          ) : (
            <ul className="rh-list">
              {records.map((record) => {
                const thumbs = THUMB_IDS.map((id) =>
                  record.frames.find((f) => f.id === id),
                ).filter((f): f is RecordFrame => f !== undefined);

                return (
                  <li className="rh-card" key={record.id}>
                    {/* カード本体をタップで詳細へ (削除ボタンとの入れ子を避けるため兄弟要素) */}
                    <button
                      type="button"
                      className="rh-card-main"
                      onClick={() => setSelectedId(record.id)}
                    >
                      <div className="rh-card-meta">
                        <span className="rh-card-date">{formatDateTime(record.createdAt)}</span>
                        <span className="rh-card-club">
                          {record.clubName !== '' ? record.clubName : 'クラブ未選択'}
                        </span>
                        {record.clubHead !== '' && (
                          <span className="rh-card-head">{record.clubHead}</span>
                        )}
                      </div>

                      <div className="rh-card-thumbs">
                        {thumbs.map((frame) => (
                          <span className="rh-card-thumb" key={frame.id}>
                            <img
                              className="rh-card-thumb-img"
                              src={frame.imageUrl}
                              alt={P_POINT_INFO[frame.id].label}
                              draggable={false}
                            />
                            <span className="rh-card-thumb-tag">
                              {P_POINT_INFO[frame.id].short}
                            </span>
                          </span>
                        ))}
                      </div>

                      {record.note !== undefined && record.note !== '' && (
                        <span className="rh-card-note">{record.note}</span>
                      )}
                    </button>

                    <button
                      type="button"
                      className="rh-delete-btn"
                      title="この記録を削除"
                      aria-label="この記録を削除"
                      onClick={() => handleDelete(record)}
                    >
                      ✕
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : (
        /* ===== 詳細ビュー ===== */
        <>
          <div className="rh-header">
            <button
              type="button"
              className="rh-back-btn"
              onClick={() => setSelectedId(null)}
            >
              ← 一覧に戻る
            </button>
            <span className="rh-detail-date">{formatDateTime(selected.createdAt)}</span>
          </div>

          <div className="rh-detail-club">
            <span className="rh-detail-club-name">
              {selected.clubName !== '' ? selected.clubName : 'クラブ未選択'}
            </span>
            {selected.clubHead !== '' && (
              <span className="rh-detail-club-head">{selected.clubHead}</span>
            )}
          </div>

          {/* デスクトップ5列×2行 / スマホ2列 */}
          <div className="rh-grid">
            {selected.frames.map((frame) => {
              const info = P_POINT_INFO[frame.id];
              const style = { '--rh-color': info.color } as CSSProperties;

              return (
                <button
                  type="button"
                  key={frame.id}
                  className="rh-grid-card"
                  style={style}
                  title={info.description}
                  onClick={() => setZoomUrl(frame.imageUrl)}
                >
                  <div className="rh-grid-thumb">
                    <img
                      className="rh-grid-thumb-img"
                      src={frame.imageUrl}
                      alt={info.label}
                      draggable={false}
                    />
                  </div>
                  <div className="rh-grid-meta">
                    <span className="rh-grid-label">{info.label}</span>
                    <span className="rh-grid-time">{frame.timeSec.toFixed(2)}s</span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* メモ (フォーカスを外したタイミングで保存) */}
          <div className="rh-note">
            <label className="rh-note-label" htmlFor="rh-note-input">
              メモ
            </label>
            <textarea
              id="rh-note-input"
              key={selected.id}
              className="rh-note-input"
              rows={3}
              placeholder="気づいたこと、調子、天候など"
              defaultValue={selected.note ?? ''}
              onBlur={(e) => handleNoteBlur(selected, e.currentTarget.value)}
            />
          </div>
        </>
      )}

      {/* ===== 画像拡大オーバーレイ (どこをタップしても閉じる) ===== */}
      {zoomUrl !== null && (
        <div
          className="rh-zoom-overlay"
          role="presentation"
          onClick={() => setZoomUrl(null)}
        >
          <img className="rh-zoom-img" src={zoomUrl} alt="拡大表示" draggable={false} />
          <span className="rh-zoom-hint">タップで閉じる</span>
        </div>
      )}
    </div>
  );
}
