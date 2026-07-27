/**
 * P システム (P1〜P10) の共有型定義
 *
 * ゴルフスイングを 10 の基準ポジションに分割する業界標準の表記。
 * 自動検出 (pPositionDetector) とタイムライン UI (PPointTimeline) と
 * ギャラリー (PPointGallery) がこの型を介して連携する。
 */

export type PPointId =
  | 'P1' | 'P2' | 'P3' | 'P4' | 'P5'
  | 'P6' | 'P7' | 'P8' | 'P9' | 'P10';

export const P_POINT_IDS: PPointId[] = [
  'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10',
];

/** 検出された（またはユーザーが調整した）P 点の位置 */
export interface PPoint {
  id: PPointId;
  /** バッチ解析フレーム番号 (0 始まり) */
  frameIndex: number;
  /** 動画時刻 (秒) */
  timeSec: number;
}

export interface PPointInfo {
  /** 表示ラベル (例: "P1 アドレス") */
  label: string;
  /** 短縮ラベル (マーカー表示用, 例: "P1") */
  short: string;
  /** 説明 */
  description: string;
  /** テーマカラー */
  color: string;
}

export const P_POINT_INFO: Record<PPointId, PPointInfo> = {
  P1:  { short: 'P1',  label: 'P1 アドレス',       description: 'セットアップ完了、始動直前',                 color: '#88ccff' },
  P2:  { short: 'P2',  label: 'P2 テイクバック',   description: 'バックスイングでシャフトが地面と平行',       color: '#66ddaa' },
  P3:  { short: 'P3',  label: 'P3 左腕水平',       description: 'バックスイングで左腕が地面と平行',           color: '#44cc66' },
  P4:  { short: 'P4',  label: 'P4 トップ',         description: 'バックスイングの頂点',                       color: '#ffcc44' },
  P5:  { short: 'P5',  label: 'P5 左腕水平(DS)',   description: 'ダウンスイングで左腕が地面と平行',           color: '#ffaa44' },
  P6:  { short: 'P6',  label: 'P6 シャフト水平(DS)', description: 'ダウンスイングでシャフトが地面と平行',     color: '#ff8844' },
  P7:  { short: 'P7',  label: 'P7 インパクト',     description: 'ボールとのコンタクトの瞬間',                 color: '#ff4466' },
  P8:  { short: 'P8',  label: 'P8 フォロー',       description: 'フォローでシャフトが地面と平行',             color: '#cc66ff' },
  P9:  { short: 'P9',  label: 'P9 右腕水平',       description: 'フォローで右腕が地面と平行',                 color: '#aa77ff' },
  P10: { short: 'P10', label: 'P10 フィニッシュ',  description: 'スイング完了',                               color: '#8888ff' },
};

/** ギャラリー表示用: P 点 + 切り出したフレーム画像 */
export interface PPointFrame {
  id: PPointId;
  timeSec: number;
  /** 切り出したフレームの dataURL (未取得なら null) */
  imageUrl: string | null;
}
