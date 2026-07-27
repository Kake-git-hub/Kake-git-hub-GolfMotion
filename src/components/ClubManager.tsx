import { useState } from 'react';
import type { Club } from '../types/club';
import { loadClubs, saveClubs, resetClubs } from '../services/clubStore';
import './clubManager.css';

/** 文字列 (テキスト直接編集) のフィールド */
type TextField = 'name' | 'head' | 'shaft' | 'balance' | 'trimming' | 'leadAdjustment' | 'underwrap';
/** 数値 (onBlur で parseFloat する) フィールド */
type NumericField = 'lengthInch' | 'totalWeightG' | 'frequencyCpm' | 'loftDeg' | 'lieAngleDeg';

interface ColumnBase {
  label: string;
  sticky?: boolean;
}

interface TextColumn extends ColumnBase {
  key: TextField;
  type: 'text';
}

interface NumericColumn extends ColumnBase {
  key: NumericField;
  type: 'numeric';
}

type ColumnDef = TextColumn | NumericColumn;

/** テーブル列定義 (表示順) */
const COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'クラブ', type: 'text', sticky: true },
  { key: 'head', label: 'ヘッド', type: 'text' },
  { key: 'shaft', label: 'シャフト', type: 'text' },
  { key: 'lengthInch', label: '長さ(inch)', type: 'numeric' },
  { key: 'balance', label: 'バランス', type: 'text' },
  { key: 'totalWeightG', label: '総重量(g)', type: 'numeric' },
  { key: 'frequencyCpm', label: '振動数(cpm)', type: 'numeric' },
  { key: 'loftDeg', label: 'ロフト(°)', type: 'numeric' },
  { key: 'lieAngleDeg', label: 'ライ角(°)', type: 'numeric' },
  { key: 'trimming', label: 'トリミング', type: 'text' },
  { key: 'leadAdjustment', label: '鉛調整', type: 'text' },
  { key: 'underwrap', label: '下巻き', type: 'text' },
];

/** 空のクラブ行を生成 */
function createEmptyClub(): Club {
  return {
    id: crypto.randomUUID(),
    name: '',
    head: '',
    shaft: '',
    lengthInch: null,
    balance: '',
    totalWeightG: null,
    frequencyCpm: null,
    loftDeg: null,
    lieAngleDeg: null,
    trimming: '',
    leadAdjustment: '',
    underwrap: '',
  };
}

/**
 * ゴルフクラブ14本のパラメータ管理画面
 *
 * タブページとして全画面表示される自己完結コンポーネント。
 * すべての編集は即座に localStorage へ保存される。
 */
export default function ClubManager() {
  // マウント時に localStorage から読み込み (lazy initializer)
  const [clubs, setClubs] = useState<Club[]>(() => loadClubs());
  // 数値セルの編集中テキスト ('3.' のような未確定入力を保持するためのバッファ)
  // key: `${clubId}:${field}`
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  /** クラブ一覧を部分更新して即保存する共通処理 */
  function updateClub(id: string, patch: Partial<Club>) {
    setClubs((prev) => {
      const next = prev.map((c) => (c.id === id ? { ...c, ...patch } : c));
      saveClubs(next);
      return next;
    });
  }

  /** テキスト系フィールドの変更 (即時反映) */
  function handleTextChange(id: string, field: TextField, value: string) {
    updateClub(id, { [field]: value } as Partial<Club>);
  }

  /** 数値系フィールドの変更 (文字列のまま編集バッファに保持するのみ) */
  function handleNumericChange(id: string, field: NumericField, value: string) {
    const key = `${id}:${field}`;
    setDrafts((prev) => ({ ...prev, [key]: value }));
  }

  /** 数値系フィールドのフォーカスアウト時に確定 (parseFloat して保存) */
  function handleNumericBlur(id: string, field: NumericField) {
    const key = `${id}:${field}`;
    if (!(key in drafts)) return;

    const trimmed = drafts[key].trim();
    const numValue = trimmed === '' ? null : parseFloat(trimmed);
    const finalValue = numValue === null || Number.isNaN(numValue) ? null : numValue;

    updateClub(id, { [field]: finalValue } as Partial<Club>);
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  /** 数値セルの表示値 (編集中はバッファの文字列、それ以外は保存値を文字列化) */
  function getNumericDisplay(club: Club, field: NumericField): string {
    const key = `${club.id}:${field}`;
    if (key in drafts) return drafts[key];
    const val = club[field];
    return val === null ? '' : String(val);
  }

  /** クラブ行を追加 */
  function handleAdd() {
    const newClub = createEmptyClub();
    setClubs((prev) => {
      const next = [...prev, newClub];
      saveClubs(next);
      return next;
    });
  }

  /** クラブ行を削除 (確認あり) */
  function handleDelete(club: Club) {
    const label = club.name.trim() || '(名称未設定)';
    if (!window.confirm(`「${label}」を削除しますか？`)) return;

    setClubs((prev) => {
      const next = prev.filter((c) => c.id !== club.id);
      saveClubs(next);
      return next;
    });
    // 削除した行に紐づく編集バッファも掃除する
    setDrafts((prev) => {
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (!k.startsWith(`${club.id}:`)) next[k] = v;
      }
      return next;
    });
  }

  /** 初期値に戻す (確認あり) */
  function handleReset() {
    if (!window.confirm('クラブ設定を初期値 (14本) に戻しますか？現在の編集内容は失われます。')) return;
    const next = resetClubs();
    setClubs(next);
    setDrafts({});
  }

  const isDefaultCount = clubs.length === 14;

  return (
    <div className="cm-container">
      <div className="cm-header">
        <h2 className="cm-title">🏌️ クラブセッティング</h2>
        <div className="cm-header-actions">
          <span className={`cm-count ${isDefaultCount ? '' : 'cm-count-warn'}`}>{clubs.length}本</span>
          <button type="button" className="cm-reset-btn" onClick={handleReset}>
            初期値に戻す
          </button>
        </div>
      </div>

      <div className="cm-table-wrap">
        <table className="cm-table">
          <thead>
            <tr>
              {COLUMNS.map((col) => (
                <th key={col.key} className={`cm-th ${col.sticky ? 'cm-th-sticky' : ''}`}>
                  {col.label}
                </th>
              ))}
              <th className="cm-th cm-th-delete">削除</th>
            </tr>
          </thead>
          <tbody>
            {clubs.map((club) => (
              <tr key={club.id} className="cm-row">
                {COLUMNS.map((col) => {
                  const cellClass = [
                    'cm-cell',
                    col.type === 'numeric' ? 'cm-cell-numeric' : '',
                    col.sticky ? 'cm-cell-sticky' : '',
                  ]
                    .filter(Boolean)
                    .join(' ');

                  return (
                    <td key={col.key} className={cellClass}>
                      {col.type === 'text' ? (
                        <input
                          type="text"
                          className="cm-input"
                          value={club[col.key]}
                          onChange={(e) => handleTextChange(club.id, col.key, e.target.value)}
                        />
                      ) : (
                        <input
                          type="text"
                          inputMode="decimal"
                          className="cm-input cm-input-numeric"
                          value={getNumericDisplay(club, col.key)}
                          onChange={(e) => handleNumericChange(club.id, col.key, e.target.value)}
                          onBlur={() => handleNumericBlur(club.id, col.key)}
                        />
                      )}
                    </td>
                  );
                })}
                <td className="cm-cell cm-cell-delete">
                  <button
                    type="button"
                    className="cm-delete-btn"
                    aria-label={`${club.name || 'クラブ'}を削除`}
                    onClick={() => handleDelete(club)}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <button type="button" className="cm-add-btn" onClick={handleAdd}>
        + クラブ追加
      </button>
    </div>
  );
}
