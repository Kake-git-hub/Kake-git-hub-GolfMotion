/**
 * スイング記録 (履歴) の共有型定義
 *
 * 動画ファイルはセッション終了後に失効する (オブジェクト URL が無効になる) ため、
 * 記録として残すのは「骨格線・角度が焼き込み済みの静止画 10 枚 (P1〜P10)」のセットと、
 * そのときの関節角度・使用クラブのスナップショット。保存後の再解析は行わない。
 *
 * RecordHistory (閲覧 UI) と recordStore (localStorage 永続化) がこの型を介して連携する。
 */

import type { PPointId } from './ppoint';
import type { Club } from './club';

/** グラフ化する関節角度の種類 */
export type AngleKey =
  | 'shoulder'    // 肩の水平回転角
  | 'leftElbow'
  | 'rightElbow'
  | 'hip'         // 腰の水平回転角
  | 'leftKnee'
  | 'rightKnee';

/** 角度グラフの系列順（この順で凡例・系列を並べる） */
export const ANGLE_KEYS: AngleKey[] = [
  'shoulder', 'hip', 'leftElbow', 'rightElbow', 'leftKnee', 'rightKnee',
];

/** 角度の表示名 */
export const ANGLE_LABELS: Record<AngleKey, string> = {
  shoulder: '肩',
  hip: '腰',
  leftElbow: '左肘',
  rightElbow: '右肘',
  leftKnee: '左膝',
  rightKnee: '右膝',
};

/**
 * angleCalculator が返す日本語ラベルから AngleKey への対応。
 * 保存時の変換に使う。
 */
export const ANGLE_LABEL_TO_KEY: Record<string, AngleKey> = {
  '肩': 'shoulder',
  '腰': 'hip',
  '左肘': 'leftElbow',
  '右肘': 'rightElbow',
  '左膝': 'leftKnee',
  '右膝': 'rightKnee',
};

/** 1コマ分の関節角度(度)。検出できなかった関節は欠落する */
export type FrameAngles = Partial<Record<AngleKey, number>>;

/** 記録に保存する1枚のP点写真(骨格焼き込み済み) */
export interface RecordFrame {
  id: PPointId;
  timeSec: number;
  /** 骨格・角度が焼き込み済みのJPEG dataURL */
  imageUrl: string;
  /** そのコマの関節角度(グラフ用)。旧データには存在しない */
  angles?: FrameAngles;
}

/** 1回のスイング分析を丸ごと保存した記録 */
export interface SwingRecord {
  id: string;
  /** 保存日時 (epoch ms) */
  createdAt: number;
  /** 使用クラブのID (クラブセット側の id)。未選択なら null */
  clubId: string | null;
  /** クラブ名のスナップショット (クラブが後で編集/削除されても記録は残る) */
  clubName: string;
  /** ヘッド名のスナップショット */
  clubHead: string;
  /**
   * 使用クラブの全スペックのスナップショット。
   * クラブ未選択なら null、旧データには存在しない。
   */
  club?: Club | null;
  /** P1〜P10、必ず10件 */
  frames: RecordFrame[];
  /** ユーザーメモ (任意) */
  note?: string;
}
