/**
 * データのバックアップ / 復元 UI
 *
 * 2 つの経路を用意している。
 *   A. ファイルの書き出し / 読み込み … OAuth 設定なしで必ず動く経路。
 *      スマホなら保存先に Google ドライブを選べるため、これだけでも目的を満たせる。
 *   B. Google ドライブ連携 … ユーザー自身の OAuth クライアント ID を登録すると
 *      アプリから直接ドライブに保存 / 復元できる。
 *
 * props は取らない自己完結コンポーネント (App 側でタブとして差し込むだけで動く)。
 */

import { useCallback, useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { BackupPayload, DataSummary, RestoreMode } from '../services/backup';
import {
  applyBackup,
  buildBackup,
  exportToFile,
  formatBytes,
  parseBackup,
  readBackupFile,
  serializeBackup,
  summarizeData,
  STORAGE_LIMIT_MB,
} from '../services/backup';
import {
  AUTHORIZED_ORIGINS,
  DRIVE_FILE_NAME,
  connect,
  disconnect,
  isConnected,
  loadClientId,
  loadFromDrive,
  loadLastSync,
  saveClientId,
  saveToDrive,
} from '../services/driveSync';
import './dataSync.css';

/* =========================================================
   補助
   ========================================================= */

/** 処理中のボタンを特定するためのキー */
type BusyKind = 'export' | 'import' | 'connect' | 'upload' | 'download' | 'restore';

/** 画面下に出すメッセージ */
interface Message {
  kind: 'ok' | 'err' | 'info';
  text: string;
}

/** 復元待ちのバックアップ (確認 UI で保持する) */
interface PendingRestore {
  payload: BackupPayload;
  /** 出所の表示用ラベル (ファイル名 / ドライブ) */
  source: string;
}

/** epoch ms を「2026/07/28 14:05」形式にする */
function formatDateTime(ms: number): string {
  if (ms <= 0) return '—';
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** クライアント ID を伏せ気味に表示する (前後だけ見せる) */
function maskClientId(id: string): string {
  if (id.length <= 16) return id;
  return `${id.slice(0, 8)}…${id.slice(-20)}`;
}

/* =========================================================
   本体
   ========================================================= */

export default function DataSync() {
  const [summary, setSummary] = useState<DataSummary>(() => summarizeData());
  const [busy, setBusy] = useState<BusyKind | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [needsReload, setNeedsReload] = useState(false);

  // --- 復元フロー ---
  const [pending, setPending] = useState<PendingRestore | null>(null);
  const [mode, setMode] = useState<RestoreMode>('merge');

  // --- Google ドライブ ---
  const [savedClientId, setSavedClientId] = useState<string>(() => loadClientId());
  const [clientIdDraft, setClientIdDraft] = useState<string>('');
  const [editingClientId, setEditingClientId] = useState<boolean>(() => loadClientId() === '');
  const [connected, setConnected] = useState<boolean>(() => isConnected());
  const [lastSync, setLastSync] = useState<number>(() => loadLastSync());

  /** 現在のデータ量を取り直す */
  const refreshSummary = useCallback(() => {
    setSummary(summarizeData());
  }, []);

  // 表示中にタブを離れて戻ってきたときのために、マウント時にも数え直す
  useEffect(() => {
    refreshSummary();
  }, [refreshSummary]);

  /* ---------------------------------------------------
     A. ファイル書き出し / 読み込み
     --------------------------------------------------- */

  const handleExport = useCallback(() => {
    setBusy('export');
    setMessage(null);
    // 直列化は同期処理なので、スピナー表示を 1 フレーム挟んでから実行する
    window.setTimeout(() => {
      const result = exportToFile();
      if (result.ok) {
        setMessage({
          kind: 'ok',
          text: `${result.fileName} を書き出しました (約 ${formatBytes(result.bytes)})。保存先に Google ドライブを選ぶと、そのままドライブに残せます。`,
        });
      } else {
        setMessage({ kind: 'err', text: result.error });
      }
      setBusy(null);
    }, 0);
  }, []);

  const handleFileChange = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0] ?? null;
    // 同じファイルを選び直しても change が起きるように値を消す
    input.value = '';
    if (file === null) return;

    setBusy('import');
    setMessage(null);
    setPending(null);

    const result = await readBackupFile(file);
    if (!result.ok) {
      setMessage({ kind: 'err', text: result.error });
      setBusy(null);
      return;
    }

    setPending({ payload: result.payload, source: file.name });
    setMessage({ kind: 'info', text: '読み込み方法を選んで「復元する」を押してください。' });
    setBusy(null);
  }, []);

  /* ---------------------------------------------------
     復元の確定 (ファイル / ドライブ 共通)
     --------------------------------------------------- */

  const handleRestore = useCallback(() => {
    if (pending === null) return;

    const recordCount = pending.payload.records.length;
    const clubSetCount = pending.payload.clubSets.length;
    const modeText =
      mode === 'replace'
        ? '【置き換え】今この端末にあるスイング記録とクラブセットは、すべて消えます。'
        : '【追加】今のデータは残したまま、重複しないものだけを追加します。';

    const okToGo = window.confirm(
      `バックアップを復元します。\n\n` +
        `読み込み元: ${pending.source}\n` +
        `スイング記録: ${recordCount} 件\n` +
        `クラブセット: ${clubSetCount} 件\n\n` +
        `${modeText}\n\nよろしいですか？`,
    );
    if (!okToGo) return;

    setBusy('restore');
    setMessage(null);
    window.setTimeout(() => {
      const result = applyBackup(pending.payload, mode);
      if (result.ok) {
        setPending(null);
        setNeedsReload(true);
        setMessage({
          kind: 'ok',
          text:
            mode === 'replace'
              ? `復元しました。スイング記録 ${result.recordCount} 件 / クラブセット ${result.clubSetCount} 件。`
              : `追加しました。スイング記録 +${result.addedRecords} 件 (合計 ${result.recordCount} 件) / クラブセット +${result.addedClubSets} 件 (合計 ${result.clubSetCount} 件)。`,
        });
      } else {
        setMessage({ kind: 'err', text: result.error });
      }
      refreshSummary();
      setBusy(null);
    }, 0);
  }, [pending, mode, refreshSummary]);

  const handleCancelRestore = useCallback(() => {
    setPending(null);
    setMessage(null);
  }, []);

  /* ---------------------------------------------------
     B. Google ドライブ
     --------------------------------------------------- */

  const handleSaveClientId = useCallback(() => {
    const trimmed = clientIdDraft.trim();
    if (trimmed === '') {
      setMessage({ kind: 'err', text: 'クライアント ID を入力してください。' });
      return;
    }
    if (!saveClientId(trimmed)) {
      setMessage({ kind: 'err', text: 'クライアント ID を保存できませんでした。' });
      return;
    }
    // ID が変わったら今のトークンは無効
    disconnect();
    setConnected(false);
    setSavedClientId(trimmed);
    setEditingClientId(false);
    setMessage({ kind: 'ok', text: 'クライアント ID を保存しました。「接続」を押してください。' });
  }, [clientIdDraft]);

  const handleEditClientId = useCallback(() => {
    setClientIdDraft(savedClientId);
    setEditingClientId(true);
  }, [savedClientId]);

  const handleConnect = useCallback(async () => {
    setBusy('connect');
    setMessage(null);

    const result = await connect(savedClientId);
    if (result.ok) {
      setConnected(true);
      setMessage({ kind: 'ok', text: 'Google ドライブに接続しました。' });
    } else {
      setConnected(false);
      setMessage({ kind: 'err', text: result.error });
    }
    setBusy(null);
  }, [savedClientId]);

  const handleDisconnect = useCallback(() => {
    disconnect();
    setConnected(false);
    setMessage({ kind: 'info', text: '接続を解除しました。' });
  }, []);

  const handleUpload = useCallback(async () => {
    setBusy('upload');
    setMessage(null);

    const json = serializeBackup(buildBackup());
    const result = await saveToDrive(json);
    if (result.ok) {
      setLastSync(loadLastSync());
      setMessage({
        kind: 'ok',
        text: `ドライブに保存しました (${result.value.name} / 約 ${formatBytes(result.value.size ?? json.length)})。`,
      });
    } else {
      setConnected(isConnected());
      setMessage({ kind: 'err', text: result.error });
    }
    setBusy(null);
  }, []);

  const handleDownload = useCallback(async () => {
    setBusy('download');
    setMessage(null);
    setPending(null);

    const result = await loadFromDrive();
    if (!result.ok) {
      setConnected(isConnected());
      setMessage({ kind: 'err', text: result.error });
      setBusy(null);
      return;
    }

    const parsed = parseBackup(result.value.text);
    if (!parsed.ok) {
      setMessage({ kind: 'err', text: parsed.error });
      setBusy(null);
      return;
    }

    setLastSync(loadLastSync());
    setPending({ payload: parsed.payload, source: `Google ドライブ (${result.value.meta.name})` });
    setMessage({ kind: 'info', text: '読み込み方法を選んで「復元する」を押してください。' });
    setBusy(null);
  }, []);

  /* ---------------------------------------------------
     描画
     --------------------------------------------------- */

  const anyBusy = busy !== null;

  return (
    <section className="ds-root">
      <header className="ds-header">
        <h2 className="ds-title">データのバックアップ</h2>
        <p className="ds-lead">
          記録はこの端末のブラウザにだけ保存されています。機種変更や、ブラウザのデータ削除に備えて
          バックアップを取っておいてください。
        </p>
      </header>

      {/* ===== 現在のデータ量 ===== */}
      <div className="ds-stats">
        <div className="ds-stat">
          <span className="ds-stat-label">スイング記録</span>
          <span className="ds-stat-value">{summary.recordCount}</span>
          <span className="ds-stat-unit">件</span>
        </div>
        <div className="ds-stat">
          <span className="ds-stat-label">クラブセット</span>
          <span className="ds-stat-value">{summary.clubSetCount}</span>
          <span className="ds-stat-unit">件</span>
        </div>
        <div className="ds-stat">
          <span className="ds-stat-label">推定サイズ</span>
          <span className="ds-stat-value">{summary.approxMB.toFixed(2)}</span>
          <span className="ds-stat-unit">MB</span>
        </div>
      </div>

      {summary.nearLimit ? (
        <p className="ds-warn">
          データ量がブラウザの保存上限 (目安 {STORAGE_LIMIT_MB}MB) に近づいています。
          記録は 1 件あたり写真 10 枚を含むため、これ以上増えると保存に失敗することがあります。
          バックアップを取ったうえで、古い記録を削除してください。
        </p>
      ) : (
        <p className="ds-note">
          スイング記録は 1 件あたり写真 10 枚を含みます。ブラウザの保存上限 (目安
          {' '}{STORAGE_LIMIT_MB}MB) を超えると新しい記録を保存できなくなるため、定期的な書き出しをおすすめします。
        </p>
      )}

      {/* ===== メッセージ ===== */}
      {message !== null && (
        <p className={`ds-msg ds-msg--${message.kind}`} role="status">
          {message.text}
        </p>
      )}

      {needsReload && (
        <div className="ds-reload">
          <span className="ds-reload-text">復元した内容を画面に反映するには再読み込みが必要です。</span>
          <button type="button" className="ds-btn ds-btn--primary" onClick={() => window.location.reload()}>
            再読み込み
          </button>
        </div>
      )}

      {/* ===== 復元の確認パネル ===== */}
      {pending !== null && (
        <div className="ds-restore">
          <h3 className="ds-restore-title">復元の確認</h3>
          <p className="ds-restore-source">読み込み元: {pending.source}</p>
          <ul className="ds-restore-counts">
            <li>スイング記録 {pending.payload.records.length} 件</li>
            <li>クラブセット {pending.payload.clubSets.length} 件</li>
            <li>書き出し日時 {formatDateTime(pending.payload.exportedAt)}</li>
          </ul>

          <fieldset className="ds-modes">
            <legend className="ds-modes-legend">読み込み方法</legend>
            <label className="ds-mode">
              <input
                type="radio"
                name="ds-restore-mode"
                value="merge"
                checked={mode === 'merge'}
                onChange={() => setMode('merge')}
                disabled={anyBusy}
              />
              <span className="ds-mode-text">
                <strong>追加する (マージ)</strong>
                <small>今のデータは残し、重複しないものだけ足します</small>
              </span>
            </label>
            <label className="ds-mode">
              <input
                type="radio"
                name="ds-restore-mode"
                value="replace"
                checked={mode === 'replace'}
                onChange={() => setMode('replace')}
                disabled={anyBusy}
              />
              <span className="ds-mode-text">
                <strong>置き換える</strong>
                <small>今のデータを消して、バックアップの内容にします</small>
              </span>
            </label>
          </fieldset>

          <div className="ds-actions">
            <button
              type="button"
              className="ds-btn ds-btn--primary"
              onClick={handleRestore}
              disabled={anyBusy}
            >
              {busy === 'restore' ? '復元中…' : '復元する'}
            </button>
            <button type="button" className="ds-btn" onClick={handleCancelRestore} disabled={anyBusy}>
              やめる
            </button>
          </div>
        </div>
      )}

      {/* ===== セクション 1: ファイル ===== */}
      <section className="ds-card">
        <h3 className="ds-card-title">ファイルに保存 / 読み込み</h3>
        <p className="ds-card-note">
          設定不要ですぐ使えます。スマホやタブレットでは、書き出したファイルの保存先として
          <strong> Google ドライブ </strong>
          を選べます。
        </p>
        <div className="ds-actions">
          <button
            type="button"
            className="ds-btn ds-btn--primary"
            onClick={handleExport}
            disabled={anyBusy}
          >
            {busy === 'export' ? '書き出し中…' : 'ファイルに書き出す'}
          </button>

          <label className={`ds-btn ds-btn--file${anyBusy ? ' ds-btn--disabled' : ''}`}>
            {busy === 'import' ? '読み込み中…' : 'ファイルから読み込む'}
            <input
              className="ds-file-input"
              type="file"
              accept="application/json,.json"
              onChange={handleFileChange}
              disabled={anyBusy}
            />
          </label>
        </div>
      </section>

      {/* ===== セクション 2: Google ドライブ ===== */}
      <section className="ds-card">
        <h3 className="ds-card-title">Google ドライブと連携</h3>
        <p className="ds-card-note">
          自分の Google ドライブに <code className="ds-code">{DRIVE_FILE_NAME}</code>{' '}
          という名前で保存します。初回のみ、ご自分の Google Cloud で作った OAuth
          クライアント ID の登録が必要です。
        </p>

        {/* --- クライアント ID --- */}
        <div className="ds-field">
          <span className="ds-field-label">OAuth クライアント ID</span>
          {editingClientId ? (
            <div className="ds-field-row">
              <input
                className="ds-input"
                type="text"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="000000000000-xxxxxxxx.apps.googleusercontent.com"
                value={clientIdDraft}
                onChange={(e) => setClientIdDraft(e.target.value)}
                disabled={anyBusy}
              />
              <button
                type="button"
                className="ds-btn ds-btn--small"
                onClick={handleSaveClientId}
                disabled={anyBusy}
              >
                保存
              </button>
              {savedClientId !== '' && (
                <button
                  type="button"
                  className="ds-btn ds-btn--small"
                  onClick={() => setEditingClientId(false)}
                  disabled={anyBusy}
                >
                  やめる
                </button>
              )}
            </div>
          ) : (
            <div className="ds-field-row">
              <span className="ds-masked" title="保存済みのクライアント ID">
                {maskClientId(savedClientId)}
              </span>
              <button
                type="button"
                className="ds-btn ds-btn--small"
                onClick={handleEditClientId}
                disabled={anyBusy}
              >
                変更
              </button>
            </div>
          )}
        </div>

        {/* --- 接続 / 同期 --- */}
        <div className="ds-actions">
          <button
            type="button"
            className="ds-btn ds-btn--primary"
            onClick={handleConnect}
            disabled={anyBusy || savedClientId === ''}
          >
            {busy === 'connect' ? '接続中…' : connected ? '再接続' : '接続'}
          </button>

          {connected && (
            <>
              <button type="button" className="ds-btn" onClick={handleUpload} disabled={anyBusy}>
                {busy === 'upload' ? '保存中…' : 'ドライブに保存'}
              </button>
              <button type="button" className="ds-btn" onClick={handleDownload} disabled={anyBusy}>
                {busy === 'download' ? '読み込み中…' : 'ドライブから復元'}
              </button>
              <button
                type="button"
                className="ds-btn ds-btn--small"
                onClick={handleDisconnect}
                disabled={anyBusy}
              >
                接続解除
              </button>
            </>
          )}
        </div>

        <p className="ds-status">
          <span className={`ds-badge${connected ? ' ds-badge--on' : ''}`}>
            {connected ? '接続中' : '未接続'}
          </span>
          <span className="ds-status-text">最終同期: {formatDateTime(lastSync)}</span>
        </p>

        {/* --- 設定手順 (折りたたみ) --- */}
        <details className="ds-details">
          <summary className="ds-summary">クライアント ID の作り方</summary>
          <ol className="ds-steps">
            <li>
              <a
                className="ds-link"
                href="https://console.cloud.google.com/"
                target="_blank"
                rel="noreferrer noopener"
              >
                Google Cloud Console
              </a>
              を開き、プロジェクトを 1 つ作る。
            </li>
            <li>「API とサービス」→「ライブラリ」で <strong>Google Drive API</strong> を有効にする。</li>
            <li>「OAuth 同意画面」を外部で作成し、テストユーザーに自分の Google アカウントを追加する。</li>
            <li>
              「認証情報」→「認証情報を作成」→「OAuth クライアント ID」で、種類に
              <strong> ウェブ アプリケーション </strong>
              を選ぶ。
            </li>
            <li>
              「承認済みの JavaScript 生成元」に次を追加する。
              <ul className="ds-origins">
                {AUTHORIZED_ORIGINS.map((origin) => (
                  <li key={origin}>
                    <code className="ds-code">{origin}</code>
                  </li>
                ))}
              </ul>
            </li>
            <li>作成された「クライアント ID」をコピーして、上の入力欄に貼り付けて保存する。</li>
          </ol>
          <p className="ds-steps-note">
            権限は「このアプリが作成したファイルのみ (drive.file)」です。ドライブ内の他のファイルは読み取れません。
            アクセストークンは画面を開いている間だけメモリに保持し、端末には保存しません。
          </p>
        </details>
      </section>
    </section>
  );
}
