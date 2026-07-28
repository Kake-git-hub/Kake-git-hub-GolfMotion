/**
 * スイング記録 (履歴) の localStorage 永続化
 *
 * 保存形式: SwingRecord[] を JSON 化した文字列 1 本。
 * 画像は dataURL としてそのまま保存されるためサイズが大きい。
 * 保存失敗 (QuotaExceededError など) は握りつぶして console.warn するのみで、
 * 例外を呼び出し側へ伝播させない (UI が真っ白になるのを防ぐ)。
 */

import type { Club } from '../types/club';
import type { PPointId } from '../types/ppoint';
import { P_POINT_IDS } from '../types/ppoint';
import type { AngleKey, FrameAngles, RecordFrame, SwingRecord } from '../types/record';
import { ANGLE_KEYS } from '../types/record';

const STORAGE_KEY = 'golf-motion.records.v1';

/** 妥当な PPointId かどうか */
function isPPointId(v: unknown): v is PPointId {
  return typeof v === 'string' && (P_POINT_IDS as string[]).includes(v);
}

/** 有限な数値だけを通す (NaN / Infinity / 文字列は弾く) */
function finiteNumberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 文字列だけを通す (それ以外は空文字) */
function stringOrEmpty(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * 生データの角度マップを FrameAngles に正規化する
 * - 既知の AngleKey のみ採用 (未知キーは捨てる)
 * - 数値以外 / 非有限値 (NaN, Infinity) は欠落扱いにする
 * - 有効な値が 1 つも無ければ undefined (= 角度データ無し)
 */
function normalizeAngles(raw: unknown): FrameAngles | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;

  const angles: FrameAngles = {};
  let count = 0;
  for (const key of ANGLE_KEYS) {
    const v = finiteNumberOrNull(r[key]);
    if (v === null) continue;
    angles[key as AngleKey] = v;
    count += 1;
  }

  return count > 0 ? angles : undefined;
}

/**
 * 生データのクラブスナップショットを Club に正規化する
 * オブジェクトでなければ (未選択 / 破損) null
 */
function normalizeClub(raw: unknown): Club | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  return {
    id: stringOrEmpty(r.id),
    name: stringOrEmpty(r.name),
    head: stringOrEmpty(r.head),
    shaft: stringOrEmpty(r.shaft),
    lengthInch: finiteNumberOrNull(r.lengthInch),
    balance: stringOrEmpty(r.balance),
    totalWeightG: finiteNumberOrNull(r.totalWeightG),
    frequencyCpm: finiteNumberOrNull(r.frequencyCpm),
    loftDeg: finiteNumberOrNull(r.loftDeg),
    lieAngleDeg: finiteNumberOrNull(r.lieAngleDeg),
    trimming: stringOrEmpty(r.trimming),
    leadAdjustment: stringOrEmpty(r.leadAdjustment),
    underwrap: stringOrEmpty(r.underwrap),
  };
}

/**
 * 生データ 1 フレームを検証して RecordFrame に正規化する
 * 必須項目 (id / imageUrl) が欠けていれば null
 * angles は任意 (旧データには存在しない)
 */
function normalizeFrame(raw: unknown): RecordFrame | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  if (!isPPointId(r.id)) return null;
  if (typeof r.imageUrl !== 'string' || r.imageUrl === '') return null;

  const frame: RecordFrame = {
    id: r.id,
    timeSec: finiteNumberOrNull(r.timeSec) ?? 0,
    imageUrl: r.imageUrl,
  };

  const angles = normalizeAngles(r.angles);
  if (angles !== undefined) frame.angles = angles;

  return frame;
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
    createdAt: finiteNumberOrNull(r.createdAt) ?? 0,
    clubId: typeof r.clubId === 'string' && r.clubId !== '' ? r.clubId : null,
    clubName: stringOrEmpty(r.clubName),
    clubHead: stringOrEmpty(r.clubHead),
    frames,
  };
  // club はキーが存在するときだけ持たせる (旧データは undefined のまま)
  if ('club' in r) record.club = normalizeClub(r.club);
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
