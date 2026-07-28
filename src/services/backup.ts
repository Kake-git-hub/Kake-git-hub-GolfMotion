/**
 * データのバックアップ (書き出し / 取り込み)
 *
 * localStorage にある 2 つのデータ
 *   - スイング記録   'golf-motion.records.v1'  (P1〜P10 の JPEG dataURL を含むため巨大)
 *   - クラブセット   'golf-motion.clubSets.v1'
 * を 1 つの JSON にまとめ、ファイルとして書き出し / 読み込みする。
 *
 * 方針は既存ストアと同じで「例外を投げない」。
 * 失敗は必ず { ok: false, error: 日本語メッセージ } として返し、
 * 呼び出し側 (DataSync) がそのまま画面に出せるようにする。
 */

import type { ClubSet } from '../types/club';
import type { SwingRecord } from '../types/record';
import { RECORDS_STORAGE_KEY, listRecords, replaceAllRecords } from './recordStore';
import { CLUB_SETS_STORAGE_KEY, loadClubSets, replaceAllClubSets } from './clubSetStore';

/* =========================================================
   型
   ========================================================= */

/** バックアップ形式のバージョン (将来の互換のため) */
export const BACKUP_VERSION = 1;

/** バックアップファイルの中身 */
export interface BackupPayload {
  /** 形式のバージョン。将来の互換のため */
  version: 1;
  /** 書き出した日時 (epoch ms) */
  exportedAt: number;
  records: SwingRecord[];
  clubSets: ClubSet[];
}

/** 復元の方法: 全置き換え / 既存に追加 (id 重複は既存を優先) */
export type RestoreMode = 'replace' | 'merge';

/** parseBackup の結果 */
export type ParseResult =
  | { ok: true; payload: BackupPayload }
  | { ok: false; error: string };

/** applyBackup の結果 */
export type ApplyResult =
  | {
      ok: true;
      /** 復元後の記録の総件数 */
      recordCount: number;
      /** 復元後のクラブセットの総件数 */
      clubSetCount: number;
      /** 今回新しく増えた記録の件数 (置き換え時は復元件数と同じ) */
      addedRecords: number;
      /** 今回新しく増えたクラブセットの件数 */
      addedClubSets: number;
    }
  | { ok: false; error: string };

/** 画面に出す「現在のデータ量」 */
export interface DataSummary {
  recordCount: number;
  clubSetCount: number;
  /** localStorage 上のおおよその文字数 (dataURL は ASCII なのでほぼバイト数と等しい) */
  approxBytes: number;
  /** approxBytes を MB に換算した値 */
  approxMB: number;
  /** localStorage の上限 (概ね 5MB) に近い / 超えている */
  nearLimit: boolean;
}

/** ブラウザの localStorage の一般的な上限 (MB)。厳密な値ではなく注意喚起の目安 */
export const STORAGE_LIMIT_MB = 5;

/* =========================================================
   現在のデータ量
   ========================================================= */

/** localStorage の 1 キー分の文字数 (読めなければ 0) */
function storedLength(key: string): number {
  try {
    return localStorage.getItem(key)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** バイト数を読みやすい文字列にする (KB / MB) */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * 現在保存されているデータ量をまとめる
 * サイズは JSON 文字列の長さからの概算 (正確なバイト数ではない)
 */
export function summarizeData(): DataSummary {
  const approxBytes = storedLength(RECORDS_STORAGE_KEY) + storedLength(CLUB_SETS_STORAGE_KEY);
  const approxMB = approxBytes / (1024 * 1024);

  return {
    recordCount: listRecords().length,
    clubSetCount: loadClubSets().length,
    approxBytes,
    approxMB,
    // 上限の 8 割を超えたら警告する
    nearLimit: approxMB >= STORAGE_LIMIT_MB * 0.8,
  };
}

/* =========================================================
   組み立て / 直列化
   ========================================================= */

/** 現在の localStorage の内容からバックアップを組み立てる */
export function buildBackup(): BackupPayload {
  return {
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    records: listRecords(),
    clubSets: loadClubSets(),
  };
}

/** バックアップを JSON 文字列にする (ファイル / ドライブ双方の本文) */
export function serializeBackup(payload: BackupPayload): string {
  return JSON.stringify(payload);
}

/** `golf-motion-backup-YYYYMMDD-HHmm.json` 形式のファイル名を作る */
export function backupFileName(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `golf-motion-backup-${stamp}.json`;
}

/* =========================================================
   検証
   ========================================================= */

/**
 * バックアップ JSON を検証して読み取る
 * 例外は投げず、不正な内容は日本語のエラーメッセージで返す
 */
export function parseBackup(text: string): ParseResult {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, error: 'ファイルの中身が空です。' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: 'JSON として読み取れませんでした。バックアップファイルが壊れているか、別の種類のファイルを選んでいる可能性があります。',
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'バックアップの形式が正しくありません。' };
  }

  const raw = parsed as Record<string, unknown>;

  if (raw.version !== BACKUP_VERSION) {
    const shown = typeof raw.version === 'number' ? String(raw.version) : '不明';
    return {
      ok: false,
      error: `対応していないバックアップ形式です (version: ${shown})。このアプリで書き出したファイルを選んでください。`,
    };
  }

  if (!Array.isArray(raw.records)) {
    return { ok: false, error: 'スイング記録 (records) が見つかりません。バックアップファイルが壊れている可能性があります。' };
  }

  if (!Array.isArray(raw.clubSets)) {
    return { ok: false, error: 'クラブセット (clubSets) が見つかりません。バックアップファイルが壊れている可能性があります。' };
  }

  const exportedAt =
    typeof raw.exportedAt === 'number' && Number.isFinite(raw.exportedAt) ? raw.exportedAt : 0;

  // 個々の要素の妥当性は保存時 (replaceAll*) の正規化に任せる。
  // ここでは「器」が正しいことだけを確認する。
  return {
    ok: true,
    payload: {
      version: BACKUP_VERSION,
      exportedAt,
      records: raw.records as SwingRecord[],
      clubSets: raw.clubSets as ClubSet[],
    },
  };
}

/* =========================================================
   適用 (復元)
   ========================================================= */

/**
 * バックアップを localStorage に適用する
 *
 * - 'replace' … 現在のデータを捨ててバックアップの内容にする
 * - 'merge'   … 現在のデータに追加する (id が重複するものは既存を残す)
 *
 * 呼び出し前に確認ダイアログを出すのは UI 側の責務。
 */
export function applyBackup(payload: BackupPayload, mode: RestoreMode): ApplyResult {
  const merge = mode === 'merge';
  // マージ時のみ現在の内容を先頭に置く (id 重複は先勝ちなので既存が優先される)
  const currentRecords = merge ? listRecords() : [];
  const currentSets = merge ? loadClubSets() : [];

  const savedRecords = replaceAllRecords(
    merge ? [...currentRecords, ...payload.records] : payload.records,
  );
  if (savedRecords === null) {
    return {
      ok: false,
      error: 'スイング記録の保存に失敗しました。データ量がブラウザの保存上限を超えている可能性があります (不要な記録を削除してからお試しください)。',
    };
  }

  const savedSets = replaceAllClubSets(
    merge ? [...currentSets, ...payload.clubSets] : payload.clubSets,
  );
  if (savedSets === null) {
    return {
      ok: false,
      error: 'クラブセットの保存に失敗しました。スイング記録は復元済みです。',
    };
  }

  return {
    ok: true,
    recordCount: savedRecords.length,
    clubSetCount: savedSets.length,
    addedRecords: savedRecords.length - currentRecords.length,
    addedClubSets: savedSets.length - currentSets.length,
  };
}

/* =========================================================
   ファイル入出力
   ========================================================= */

/** exportToFile の結果 */
export type ExportResult =
  | { ok: true; fileName: string; bytes: number }
  | { ok: false; error: string };

/**
 * バックアップをファイルとしてダウンロードする
 * スマホのダウンロード先として Google ドライブを選べるため、これだけでも
 * 「ドライブに保存する」という目的は達成できる。
 */
export function exportToFile(payload: BackupPayload = buildBackup()): ExportResult {
  let url: string | null = null;
  try {
    const json = serializeBackup(payload);
    const fileName = backupFileName();
    const blob = new Blob([json], { type: 'application/json' });
    url = URL.createObjectURL(blob);

    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    // click 直後に revoke すると保存に失敗するブラウザがあるため少し遅らせる
    const revokeTarget = url;
    window.setTimeout(() => URL.revokeObjectURL(revokeTarget), 60_000);

    return { ok: true, fileName, bytes: json.length };
  } catch (e) {
    console.warn('バックアップの書き出しに失敗しました', e);
    if (url !== null) URL.revokeObjectURL(url);
    return {
      ok: false,
      error: 'ファイルの書き出しに失敗しました。データ量が大きすぎるか、ブラウザがダウンロードをブロックした可能性があります。',
    };
  }
}

/**
 * 選択されたファイルを読み込んで検証する
 * 読み取り自体に失敗した場合も例外は投げず ParseResult で返す
 */
export async function readBackupFile(file: File): Promise<ParseResult> {
  let text: string;
  try {
    text = await file.text();
  } catch (e) {
    console.warn('バックアップファイルの読み込みに失敗しました', e);
    return { ok: false, error: 'ファイルを読み込めませんでした。もう一度選び直してください。' };
  }
  return parseBackup(text);
}
