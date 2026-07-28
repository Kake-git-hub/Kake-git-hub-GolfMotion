/**
 * Google ドライブ連携 (バックアップの保存 / 復元)
 *
 * 構成:
 *   - 認可: Google Identity Services (GIS) の「トークンクライアント」
 *           スクリプト https://accounts.google.com/gsi/client を動的に読み込む
 *           (index.html は編集しない方針のため)
 *   - API : Drive REST API v3 を fetch で直接呼ぶ (gapi クライアントは使わない)
 *
 * スコープは drive.file (このアプリが作ったファイルだけにアクセスできる) を使う。
 * appDataFolder ではなくマイドライブ直下に置くことで、ユーザーが自分の
 * ドライブ上でバックアップファイルを見つけられるようにしている。
 *
 * バックエンドを持たない静的サイトのため OAuth クライアント ID をアプリに
 * 埋め込むことができない。ユーザー自身が Google Cloud で作成した ID を
 * localStorage に保存して使う。
 *
 * アクセストークンはメモリにのみ保持する (localStorage には書かない)。
 *
 * 本モジュールは例外を投げない。失敗は必ず
 * { ok: false, error: 日本語メッセージ } として返す。
 */

/* =========================================================
   定数
   ========================================================= */

/** OAuth クライアント ID の保存キー */
const CLIENT_ID_KEY = 'golf-motion.driveClientId';
/** 最終同期日時 (epoch ms) の保存キー */
const LAST_SYNC_KEY = 'golf-motion.driveLastSync';
/** GIS スクリプトの URL */
const GIS_SRC = 'https://accounts.google.com/gsi/client';
/** 要求するスコープ (アプリが作成したファイルのみ) */
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
/** ドライブ上のバックアップファイル名 (固定) */
export const DRIVE_FILE_NAME = 'golf-motion-backup.json';
/** GIS スクリプトの読み込みタイムアウト (ms) */
const GIS_LOAD_TIMEOUT_MS = 15_000;
/** 認可フローのタイムアウト (ms)。ユーザーが同意画面を放置した場合の保険 */
const AUTH_TIMEOUT_MS = 180_000;

/**
 * Google Cloud Console の「承認済みの JavaScript 生成元」に登録が必要なオリジン
 * (設定手順の表示に使う)
 */
export const AUTHORIZED_ORIGINS = ['https://kake-git-hub.github.io', 'http://localhost:5199'];

/* =========================================================
   型
   ========================================================= */

/** 本モジュールの共通の戻り値 */
export type DriveResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** ドライブ上のファイル情報 */
export interface DriveFileMeta {
  id: string;
  name: string;
  /** RFC3339 文字列 */
  modifiedTime: string;
  /** バイト数 (取得できなければ null) */
  size: number | null;
}

/* --- GIS の最小限の型定義 (@types が無いため自前で宣言する) --- */

interface GisTokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface GisErrorInfo {
  type?: string;
  message?: string;
}

interface GisTokenClient {
  requestAccessToken: (overrideConfig?: { prompt?: string }) => void;
}

interface GisTokenClientConfig {
  client_id: string;
  scope: string;
  callback: (response: GisTokenResponse) => void;
  error_callback?: (error: GisErrorInfo) => void;
}

interface GisNamespace {
  accounts: {
    oauth2: {
      initTokenClient: (config: GisTokenClientConfig) => GisTokenClient;
      revoke?: (token: string, done?: () => void) => void;
    };
  };
}

/* =========================================================
   クライアント ID / 最終同期日時 (localStorage)
   ========================================================= */

/** 保存済みのクライアント ID を読む (未設定なら空文字) */
export function loadClientId(): string {
  try {
    return localStorage.getItem(CLIENT_ID_KEY)?.trim() ?? '';
  } catch {
    return '';
  }
}

/**
 * クライアント ID を保存する
 * 空文字なら保存せず false を返す
 */
export function saveClientId(clientId: string): boolean {
  const trimmed = clientId.trim();
  if (trimmed === '') return false;
  try {
    localStorage.setItem(CLIENT_ID_KEY, trimmed);
    return true;
  } catch (e) {
    console.warn('クライアント ID の保存に失敗しました', e);
    return false;
  }
}

/** クライアント ID を消す (接続状態も解除する) */
export function clearClientId(): void {
  try {
    localStorage.removeItem(CLIENT_ID_KEY);
  } catch (e) {
    console.warn('クライアント ID の削除に失敗しました', e);
  }
  disconnect();
}

/** 最終同期日時 (epoch ms)。未同期なら 0 */
export function loadLastSync(): number {
  try {
    const raw = localStorage.getItem(LAST_SYNC_KEY);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** 最終同期日時を記録する */
function saveLastSync(at: number): void {
  try {
    localStorage.setItem(LAST_SYNC_KEY, String(at));
  } catch (e) {
    console.warn('最終同期日時の保存に失敗しました', e);
  }
}

/* =========================================================
   GIS スクリプトの動的読み込み
   ========================================================= */

/** window.google が使える状態なら取り出す */
function getGis(): GisNamespace | null {
  const w = window as unknown as { google?: Partial<GisNamespace> };
  const oauth2 = w.google?.accounts?.oauth2;
  return oauth2 && typeof oauth2.initTokenClient === 'function' ? (w.google as GisNamespace) : null;
}

/** 読み込み中 / 読み込み済みの Promise (二重ロード防止) */
let gisLoading: Promise<boolean> | null = null;

/**
 * GIS スクリプトを読み込む (読み込み済みなら即 true)
 * 失敗しても例外は投げず false を返す
 */
function loadGis(): Promise<boolean> {
  if (getGis() !== null) return Promise.resolve(true);
  if (gisLoading !== null) return gisLoading;

  gisLoading = new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      // 失敗時は次回やり直せるようにキャッシュを捨てる
      if (!ok) gisLoading = null;
      resolve(ok);
    };

    const timer = window.setTimeout(() => finish(false), GIS_LOAD_TIMEOUT_MS);

    try {
      const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
      const script = existing ?? document.createElement('script');
      script.addEventListener('load', () => finish(getGis() !== null), { once: true });
      script.addEventListener('error', () => finish(false), { once: true });

      if (existing === null) {
        script.src = GIS_SRC;
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
    } catch (e) {
      console.warn('GIS スクリプトの読み込みに失敗しました', e);
      finish(false);
    }
  });

  return gisLoading;
}

/* =========================================================
   アクセストークン (メモリ保持)
   ========================================================= */

let accessToken: string | null = null;
/** トークンの失効時刻 (epoch ms) */
let tokenExpiresAt = 0;

/** 接続済み (有効なトークンを持っている) かどうか */
export function isConnected(): boolean {
  return accessToken !== null && Date.now() < tokenExpiresAt;
}

/** 接続を解除する (メモリ上のトークンを捨てるだけ) */
export function disconnect(): void {
  accessToken = null;
  tokenExpiresAt = 0;
}

/** GIS のエラー種別を日本語メッセージに変換する */
function describeAuthError(type: string | undefined, fallback: string): string {
  switch (type) {
    case 'popup_failed_to_open':
      return 'ログイン用のポップアップを開けませんでした。ブラウザのポップアップブロックを解除してから、もう一度お試しください。';
    case 'popup_closed':
      return 'ログイン画面が閉じられたため、接続できませんでした。';
    case 'access_denied':
      return 'アクセスが許可されませんでした。Google ドライブへのアクセスを許可してください。';
    default:
      return fallback;
  }
}

/**
 * アクセストークンを取得する (必要ならポップアップで同意を求める)
 */
function requestAccessToken(clientId: string): Promise<DriveResult<string>> {
  return new Promise<DriveResult<string>>((resolve) => {
    const gis = getGis();
    if (gis === null) {
      resolve({ ok: false, error: 'Google のログイン機能を初期化できませんでした。ページを再読み込みしてお試しください。' });
      return;
    }

    let settled = false;
    const finish = (result: DriveResult<string>): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(result);
    };

    const timer = window.setTimeout(() => {
      finish({ ok: false, error: '認証がタイムアウトしました。もう一度「接続」をお試しください。' });
    }, AUTH_TIMEOUT_MS);

    try {
      const client = gis.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPE,
        callback: (response) => {
          if (response.error !== undefined) {
            finish({
              ok: false,
              error: describeAuthError(
                response.error,
                `Google の認証に失敗しました (${response.error_description ?? response.error})。クライアント ID と「承認済みの JavaScript 生成元」の設定をご確認ください。`,
              ),
            });
            return;
          }
          if (typeof response.access_token !== 'string' || response.access_token === '') {
            finish({ ok: false, error: 'アクセストークンを取得できませんでした。もう一度お試しください。' });
            return;
          }

          accessToken = response.access_token;
          // expires_in が無い場合は控えめに 30 分とみなす。1 分早めに失効させる
          const lifetimeSec = typeof response.expires_in === 'number' ? response.expires_in : 1800;
          tokenExpiresAt = Date.now() + Math.max(lifetimeSec - 60, 60) * 1000;
          finish({ ok: true, value: response.access_token });
        },
        error_callback: (error) => {
          finish({
            ok: false,
            error: describeAuthError(
              error.type,
              `Google の認証に失敗しました${error.message ? ` (${error.message})` : ''}。`,
            ),
          });
        },
      });

      // prompt: '' … 既に許可済みなら同意画面を出さずにトークンだけ取り直す
      client.requestAccessToken({ prompt: '' });
    } catch (e) {
      console.warn('トークンの要求に失敗しました', e);
      finish({
        ok: false,
        error: 'Google の認証を開始できませんでした。クライアント ID が正しいかご確認ください。',
      });
    }
  });
}

/**
 * Google ドライブに接続する (GIS 読み込み → トークン取得)
 * clientId を省略すると保存済みの値を使う
 */
export async function connect(clientId: string = loadClientId()): Promise<DriveResult<void>> {
  const id = clientId.trim();
  if (id === '') {
    return {
      ok: false,
      error: 'OAuth クライアント ID が設定されていません。下の入力欄に、Google Cloud Console で作成したクライアント ID を入力して保存してください。',
    };
  }

  const loaded = await loadGis();
  if (!loaded) {
    return {
      ok: false,
      error: 'Google のログイン用スクリプトを読み込めませんでした。通信環境、広告ブロッカー、プライバシー保護機能の設定をご確認ください。',
    };
  }

  const token = await requestAccessToken(id);
  if (!token.ok) return { ok: false, error: token.error };

  return { ok: true, value: undefined };
}

/* =========================================================
   Drive REST API v3
   ========================================================= */

/** HTTP ステータスを日本語メッセージに変換する */
function describeHttpError(status: number, body: string): string {
  if (status === 401) {
    return 'Google ドライブの認証の有効期限が切れました。「接続」ボタンからもう一度ログインしてください。';
  }
  if (status === 403) {
    return 'Google ドライブへのアクセスが拒否されました。Google Cloud のプロジェクトで Drive API が有効になっているか、OAuth 同意画面のテストユーザーに自分のアカウントが登録されているかをご確認ください。';
  }
  if (status === 404) {
    return 'ドライブ上のファイルが見つかりませんでした。';
  }
  if (status === 429 || status >= 500) {
    return `Google ドライブが一時的に応答できませんでした (HTTP ${status})。しばらく待ってからお試しください。`;
  }
  const detail = body.slice(0, 200);
  return `Google ドライブとの通信に失敗しました (HTTP ${status})${detail ? `: ${detail}` : ''}`;
}

/**
 * 認証付きで Drive API を呼ぶ
 * 401 のときはメモリ上のトークンを捨てて再接続を促す
 */
async function driveFetch(url: string, init?: RequestInit): Promise<DriveResult<Response>> {
  if (!isConnected() || accessToken === null) {
    return {
      ok: false,
      error: 'Google ドライブに接続していません。先に「接続」ボタンを押してください。',
    };
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${accessToken}` },
    });
  } catch (e) {
    console.warn('Drive API の呼び出しに失敗しました', e);
    return { ok: false, error: 'ネットワークエラーが発生しました。通信環境をご確認ください。' };
  }

  if (!response.ok) {
    if (response.status === 401) disconnect();
    let body = '';
    try {
      body = await response.text();
    } catch {
      /* 本文が読めなくてもステータスだけで案内する */
    }
    return { ok: false, error: describeHttpError(response.status, body) };
  }

  return { ok: true, value: response };
}

/** Drive API のファイル JSON を DriveFileMeta に変換する */
function toFileMeta(raw: unknown): DriveFileMeta | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id === '') return null;

  const size = typeof r.size === 'string' ? Number(r.size) : null;
  return {
    id: r.id,
    name: typeof r.name === 'string' ? r.name : DRIVE_FILE_NAME,
    modifiedTime: typeof r.modifiedTime === 'string' ? r.modifiedTime : '',
    size: size !== null && Number.isFinite(size) ? size : null,
  };
}

/**
 * ドライブ上のバックアップファイルを探す
 * 見つからない場合は value: null (エラーではない)
 */
export async function findBackupFile(): Promise<DriveResult<DriveFileMeta | null>> {
  const query = `name='${DRIVE_FILE_NAME}' and trashed=false`;
  const url =
    'https://www.googleapis.com/drive/v3/files' +
    `?q=${encodeURIComponent(query)}` +
    `&fields=${encodeURIComponent('files(id,name,modifiedTime,size)')}` +
    '&spaces=drive&pageSize=10&orderBy=modifiedTime desc';

  const res = await driveFetch(url);
  if (!res.ok) return { ok: false, error: res.error };

  try {
    const json: unknown = await res.value.json();
    const files = (json as { files?: unknown }).files;
    if (!Array.isArray(files) || files.length === 0) return { ok: true, value: null };
    return { ok: true, value: toFileMeta(files[0]) };
  } catch (e) {
    console.warn('ファイル検索結果の解析に失敗しました', e);
    return { ok: false, error: 'Google ドライブからの応答を解釈できませんでした。' };
  }
}

/**
 * バックアップ JSON をドライブに保存する
 * 同名ファイルがあれば内容を更新し、無ければ新規作成する
 */
export async function saveToDrive(json: string): Promise<DriveResult<DriveFileMeta>> {
  const found = await findBackupFile();
  if (!found.ok) return { ok: false, error: found.error };

  const fields = encodeURIComponent('id,name,modifiedTime,size');
  let res: DriveResult<Response>;

  if (found.value !== null) {
    // 既存ファイルの中身だけ差し替える
    res = await driveFetch(
      `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(found.value.id)}?uploadType=media&fields=${fields}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: json,
      },
    );
  } else {
    // 新規作成 (メタデータ + 本文の multipart)
    const boundary = `golfmotion${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const metadata = JSON.stringify({ name: DRIVE_FILE_NAME, mimeType: 'application/json' });
    const body =
      `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      `${metadata}\r\n` +
      `--${boundary}\r\n` +
      'Content-Type: application/json\r\n\r\n' +
      `${json}\r\n` +
      `--${boundary}--`;

    res = await driveFetch(
      `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=${fields}`,
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      },
    );
  }

  if (!res.ok) return { ok: false, error: res.error };

  try {
    const meta = toFileMeta(await res.value.json());
    if (meta === null) {
      return { ok: false, error: '保存はできましたが、ファイル情報を取得できませんでした。' };
    }
    saveLastSync(Date.now());
    return { ok: true, value: meta };
  } catch (e) {
    console.warn('保存結果の解析に失敗しました', e);
    return { ok: false, error: 'Google ドライブからの応答を解釈できませんでした。' };
  }
}

/** ドライブからバックアップ JSON を読み出す */
export async function loadFromDrive(): Promise<DriveResult<{ text: string; meta: DriveFileMeta }>> {
  const found = await findBackupFile();
  if (!found.ok) return { ok: false, error: found.error };
  if (found.value === null) {
    return {
      ok: false,
      error: `ドライブにバックアップファイル (${DRIVE_FILE_NAME}) が見つかりませんでした。先に「ドライブに保存」を実行してください。`,
    };
  }

  const meta = found.value;
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(meta.id)}?alt=media`,
  );
  if (!res.ok) return { ok: false, error: res.error };

  try {
    const text = await res.value.text();
    saveLastSync(Date.now());
    return { ok: true, value: { text, meta } };
  } catch (e) {
    console.warn('ファイル本文の取得に失敗しました', e);
    return { ok: false, error: 'ファイルの中身を読み取れませんでした。' };
  }
}
