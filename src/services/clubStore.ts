import type { Club } from '../types/club';
import { DEFAULT_CLUBS } from '../data/defaultClubs';

const STORAGE_KEY = 'golf-motion.clubs.v1';

/**
 * DEFAULT_CLUBS のディープコピーを返す
 * (localStorage 未保存時やマイグレーション不能時のフォールバック用)
 */
function cloneDefaultClubs(): Club[] {
  return DEFAULT_CLUBS.map((club) => ({ ...club }));
}

/**
 * 読み込んだ生データの欠損フィールドをデフォルト値で補完する
 * (型のバージョンアップなどで古い保存データにフィールドが足りない場合の軽いマイグレーション)
 */
function normalizeClub(raw: unknown): Club | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const toStr = (v: unknown): string => (typeof v === 'string' ? v : '');
  const toNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  return {
    id: typeof r.id === 'string' && r.id !== '' ? r.id : crypto.randomUUID(),
    name: toStr(r.name),
    head: toStr(r.head),
    shaft: toStr(r.shaft),
    lengthInch: toNum(r.lengthInch),
    balance: toStr(r.balance),
    totalWeightG: toNum(r.totalWeightG),
    frequencyCpm: toNum(r.frequencyCpm),
    loftDeg: toNum(r.loftDeg),
    lieAngleDeg: toNum(r.lieAngleDeg),
    trimming: toStr(r.trimming),
    leadAdjustment: toStr(r.leadAdjustment),
    underwrap: toStr(r.underwrap),
  };
}

/**
 * クラブ一覧を localStorage から読み込む
 * 未保存/JSON parse失敗/配列でない場合は DEFAULT_CLUBS のディープコピーを返す
 */
export function loadClubs(): Club[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneDefaultClubs();

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return cloneDefaultClubs();

    const clubs = parsed.map(normalizeClub).filter((c): c is Club => c !== null);
    return clubs.length > 0 ? clubs : cloneDefaultClubs();
  } catch (e) {
    console.warn('クラブデータの読み込みに失敗しました', e);
    return cloneDefaultClubs();
  }
}

/**
 * クラブ一覧を localStorage に保存する
 * 保存に失敗しても例外は投げず console.warn するのみ
 */
export function saveClubs(clubs: Club[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clubs));
  } catch (e) {
    console.warn('クラブデータの保存に失敗しました', e);
  }
}

/**
 * クラブ一覧を初期値 (DEFAULT_CLUBS) にリセットして保存し、そのコピーを返す
 */
export function resetClubs(): Club[] {
  const clubs = cloneDefaultClubs();
  saveClubs(clubs);
  return clubs;
}
