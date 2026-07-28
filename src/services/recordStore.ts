/**
 * スイング記録 (履歴) の localStorage 永続化
 *
 * 保存形式: SwingRecord[] を JSON 化した文字列 1 本。
 * 画像は dataURL としてそのまま保存されるためサイズが大きい。
 * 保存失敗 (QuotaExceededError など) は握りつぶして console.warn するのみで、
 * 例外を呼び出し側へ伝播させない (UI が真っ白になるのを防ぐ)。
 */

import type { PPointId } from '../types/ppoint';
import { P_POINT_IDS } from '../types/ppoint';
import type { RecordFrame, SwingRecord } from '../types/record';

const STORAGE_KEY = 'golf-motion.records.v1';

/** 妥当な PPointId かどうか */
function isPPointId(v: unknown): v is PPointId {
  return typeof v === 'string' && (P_POINT_IDS as string[]).includes(v);
}

/**
 * 生データ 1 フレームを検証して RecordFrame に正規化する
 * 必須項目 (id / imageUrl) が欠けていれば null
 */
function normalizeFrame(raw: unknown): RecordFrame | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  if (!isPPointId(r.id)) return null;
  if (typeof r.imageUrl !== 'string' || r.imageUrl === '') return null;

  return {
    id: r.id,
    timeSec: typeof r.timeSec === 'number' && Number.isFinite(r.timeSec) ? r.timeSec : 0,
    imageUrl: r.imageUrl,
  };
}

/**
 * 生データ 1 件を検証して SwingRecord に正規化する
 * id が無い / フレームが 1 枚も無い場合は破損とみなして null
 */
function normalizeRecord(raw: unknown): SwingRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  if (typeof r.id !== 'string' || r.id === '') return null;

  const frames = Array.isArray(r.frames)
    ? r.frames.map(normalizeFrame).filter((f): f is RecordFrame => f !== null)
    : [];
  if (frames.length === 0) return null;

  const record: SwingRecord = {
    id: r.id,
    createdAt:
      typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : 0,
    clubId: typeof r.clubId === 'string' && r.clubId !== '' ? r.clubId : null,
    clubName: typeof r.clubName === 'string' ? r.clubName : '',
    clubHead: typeof r.clubHead === 'string' ? r.clubHead : '',
    frames,
  };
  if (typeof r.note === 'string') record.note = r.note;

  return record;
}

/**
 * localStorage から全記録を読み出す (内部用)
 * 未保存 / JSON parse 失敗 / 配列でない場合は空配列
 */
function readAll(): SwingRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.map(normalizeRecord).filter((r): r is SwingRecord => r !== null);
  } catch (e) {
    console.warn('スイング記録の読み込みに失敗しました', e);
    return [];
  }
}

/**
 * 全記録を localStorage に書き戻す (内部用)
 * 失敗しても例外は投げず console.warn するのみ
 */
function writeAll(records: SwingRecord[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch (e) {
    console.warn('スイング記録の保存に失敗しました (容量超過の可能性があります)', e);
  }
}

/** 新しい順 (createdAt 降順) で全記録を返す。破損データは無視する */
export function listRecords(): SwingRecord[] {
  return readAll().sort((a, b) => b.createdAt - a.createdAt);
}

/** 1件保存 (先頭に追加)。id が既存と重複したら上書き */
export function saveRecord(record: SwingRecord): void {
  const rest = readAll().filter((r) => r.id !== record.id);
  writeAll([record, ...rest]);
}

/** id指定で1件削除 */
export function deleteRecord(id: string): void {
  writeAll(readAll().filter((r) => r.id !== id));
}

/** メモを更新 */
export function updateRecordNote(id: string, note: string): void {
  const records = readAll();
  const target = records.find((r) => r.id === id);
  if (!target) return;

  target.note = note;
  writeAll(records);
}

/** 全削除 (確認は呼び出し側の責務) */
export function clearAllRecords(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    console.warn('スイング記録の全削除に失敗しました', e);
  }
}
