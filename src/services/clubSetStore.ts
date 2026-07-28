import type { Club, ClubSet } from '../types/club';
import { DEFAULT_CLUBS } from '../data/defaultClubs';

/**
 * クラブ「セット」の永続化ストア
 *
 * 旧 clubStore.ts は単一のクラブ配列だけを保持していたが、本ストアは
 * 複数セット (レギュラー / 冬用 / 試打用 …) を管理し、そのうち 1 つを
 * 「メインセット」として解析画面に供給する。
 *
 * 保存キーは v1 系で新設し、旧キーからは初回読み込み時に自動移行する。
 */

/** 新スキーマの保存キー */
const STORAGE_KEY = 'golf-motion.clubSets.v1';
/** 旧スキーマ (clubStore.ts) の保存キー。マイグレーション元としてのみ参照する */
const LEGACY_CLUBS_KEY = 'golf-motion.clubs.v1';
/** 初期セット / マイグレーション時のセット名 */
const DEFAULT_SET_NAME = 'マイセット';

/** 一意 ID を生成する (crypto.randomUUID が無い環境へのフォールバック付き) */
function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* 続けてフォールバックへ */
  }
  return `set-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** クラブ配列のディープコピー (Club はフラットなオブジェクトなのでスプレッドで十分) */
function cloneClubs(clubs: Club[]): Club[] {
  return clubs.map((club) => ({ ...club }));
}

/** DEFAULT_CLUBS のディープコピー */
function cloneDefaultClubs(): Club[] {
  return cloneClubs(DEFAULT_CLUBS);
}

/**
 * 読み込んだ生データを Club に正規化する
 * (型のバージョンアップで古い保存データにフィールドが足りない場合の軽い補完)
 */
function normalizeClub(raw: unknown): Club | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const toStr = (v: unknown): string => (typeof v === 'string' ? v : '');
  const toNum = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;

  return {
    id: typeof r.id === 'string' && r.id !== '' ? r.id : newId(),
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

/** 読み込んだ生データを ClubSet に正規化する */
function normalizeSet(raw: unknown): ClubSet | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.clubs)) return null;

  const clubs = r.clubs.map(normalizeClub).filter((c): c is Club => c !== null);
  const now = Date.now();
  const toTime = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : now;

  return {
    id: typeof r.id === 'string' && r.id !== '' ? r.id : newId(),
    name: typeof r.name === 'string' && r.name.trim() !== '' ? r.name : DEFAULT_SET_NAME,
    clubs,
    isMain: r.isMain === true,
    createdAt: toTime(r.createdAt),
    updatedAt: toTime(r.updatedAt),
  };
}

/** isMain が必ず 1 つだけ true になるよう補正する (0 件の場合はそのまま) */
function ensureSingleMain(sets: ClubSet[]): ClubSet[] {
  if (sets.length === 0) return sets;
  const mainIndex = sets.findIndex((s) => s.isMain);
  const target = mainIndex >= 0 ? mainIndex : 0;
  return sets.map((s, i) => (s.isMain === (i === target) ? s : { ...s, isMain: i === target }));
}

/** ClubSet オブジェクトを組み立てる */
function buildSet(name: string, clubs: Club[], isMain: boolean): ClubSet {
  const now = Date.now();
  return { id: newId(), name, clubs, isMain, createdAt: now, updatedAt: now };
}

/**
 * 新キーから読み込む。存在しない / 壊れている場合は null
 *
 * 正規化 (欠損フィールドの補完・壊れたセットの除去・isMain の重複解消) で
 * 内容が変わった場合は repaired=true を返す。呼び出し側が保存し直すことで、
 * 保存データを常に正規形に保つ (読むたびに補正し続ける状態を避ける)。
 */
function readStoredSets(): { sets: ClubSet[]; repaired: boolean } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;

    const normalized = parsed.map(normalizeSet).filter((s): s is ClubSet => s !== null);
    if (normalized.length === 0) return null;

    const sets = ensureSingleMain(normalized);
    return { sets, repaired: JSON.stringify(sets) !== raw };
  } catch (e) {
    console.warn('クラブセットの読み込みに失敗しました', e);
    return null;
  }
}

/** 旧キー (単一クラブ配列) から読み込む。存在しない / 壊れている場合は null */
function readLegacyClubs(): Club[] | null {
  try {
    const raw = localStorage.getItem(LEGACY_CLUBS_KEY);
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;

    const clubs = parsed.map(normalizeClub).filter((c): c is Club => c !== null);
    return clubs.length > 0 ? clubs : null;
  } catch (e) {
    console.warn('旧クラブデータの読み込みに失敗しました', e);
    return null;
  }
}

/**
 * 全セットを返す。データが無ければマイグレーション/初期シードを行う
 *
 * 1. 新キーにデータがあればそれを返す
 * 2. 旧キー 'golf-motion.clubs.v1' があれば 1 セット「マイセット」として移行
 * 3. どちらも無い / 壊れている場合は DEFAULT_CLUBS で初期シード
 *
 * どのケースでも例外は投げない。
 */
export function loadClubSets(): ClubSet[] {
  const stored = readStoredSets();
  if (stored) {
    if (stored.repaired) saveClubSets(stored.sets);
    return stored.sets;
  }

  const legacy = readLegacyClubs();
  const seed = [buildSet(DEFAULT_SET_NAME, legacy ?? cloneDefaultClubs(), true)];
  saveClubSets(seed);
  return seed;
}

/**
 * 全セットを保存する
 * 保存に失敗しても例外は投げず console.warn するのみ
 */
export function saveClubSets(sets: ClubSet[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sets));
  } catch (e) {
    console.warn('クラブセットの保存に失敗しました', e);
  }
}

/** メインセット(isMain=trueのもの)を返す。無ければ先頭を返す。0件ならnull */
export function getMainSet(): ClubSet | null {
  const sets = loadClubSets();
  if (sets.length === 0) return null;
  return sets.find((s) => s.isMain) ?? sets[0];
}

/**
 * 新規セットを作成する
 * baseClubs を渡すとその内容をディープコピーして初期値に、省略時は DEFAULT_CLUBS ベース
 */
export function createClubSet(name: string, baseClubs?: Club[]): ClubSet {
  const sets = loadClubSets();
  const clubs = baseClubs ? cloneClubs(baseClubs) : cloneDefaultClubs();
  // 1 件も無い状態で作った場合のみ、そのセットがメインになる
  const created = buildSet(name, clubs, sets.length === 0);
  saveClubSets([...sets, created]);
  return created;
}

/** 既存セットを複製する ("(コピー)" を名前に付与)。複製後のセットを返す */
export function duplicateClubSet(id: string): ClubSet | null {
  const sets = loadClubSets();
  const index = sets.findIndex((s) => s.id === id);
  if (index < 0) return null;

  const source = sets[index];
  const copy = buildSet(`${source.name} (コピー)`, cloneClubs(source.clubs), false);
  // 複製元の直後に挿入する (一覧上で並びが分かりやすい)
  const next = [...sets.slice(0, index + 1), copy, ...sets.slice(index + 1)];
  saveClubSets(next);
  return copy;
}

/**
 * セットを削除する
 * 最後の1つは削除不可 (false を返す)。
 * 削除したセットがメインだった場合、残りの先頭を新しいメインにする。
 */
export function deleteClubSet(id: string): boolean {
  const sets = loadClubSets();
  if (sets.length <= 1) return false;
  if (!sets.some((s) => s.id === id)) return false;

  const next = ensureSingleMain(sets.filter((s) => s.id !== id));
  saveClubSets(next);
  return true;
}

/** セット名を変更する (空文字は無視) */
export function renameClubSet(id: string, name: string): void {
  const trimmed = name.trim();
  if (trimmed === '') return;

  const sets = loadClubSets();
  if (!sets.some((s) => s.id === id)) return;

  saveClubSets(
    sets.map((s) => (s.id === id ? { ...s, name: trimmed, updatedAt: Date.now() } : s)),
  );
}

/** 指定セットをメインに設定する (他は全て false に) */
export function setMainClubSet(id: string): void {
  const sets = loadClubSets();
  if (!sets.some((s) => s.id === id)) return;

  saveClubSets(sets.map((s) => ({ ...s, isMain: s.id === id })));
}

/** 指定セットのクラブ配列を丸ごと更新する (updatedAt も更新) */
export function updateClubSetClubs(id: string, clubs: Club[]): void {
  const sets = loadClubSets();
  if (!sets.some((s) => s.id === id)) return;

  saveClubSets(
    sets.map((s) => (s.id === id ? { ...s, clubs: cloneClubs(clubs), updatedAt: Date.now() } : s)),
  );
}
