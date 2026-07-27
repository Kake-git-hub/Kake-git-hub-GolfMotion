/**
 * ゴルフクラブ関連の共有型定義
 *
 * 14 本 (ドライバー〜パター) のクラブごとのスペック情報を保持する。
 * ClubManager (編集 UI) と clubStore (永続化) がこの型を介して連携する。
 */

/** ゴルフクラブ1本のパラメータ */
export interface Club {
  id: string;                    // 一意ID (React key / 選択保存用)
  name: string;                  // クラブ名 (例: '1W', 'I#7')
  head: string;                  // ヘッド
  shaft: string;                 // シャフト
  lengthInch: number | null;     // 長さ (インチ)
  balance: string;               // バランス (スイングウェイト, 例: 'D0.6')
  totalWeightG: number | null;   // 総重量 (g)
  frequencyCpm: number | null;   // 振動数 (cpm)
  loftDeg: number | null;        // ロフト (度)
  lieAngleDeg: number | null;    // ライ角 (度)
  trimming: string;              // トリミング
  leadAdjustment: string;        // 鉛調整 (例: '外+1.5g')
  underwrap: string;             // 下巻き
}
