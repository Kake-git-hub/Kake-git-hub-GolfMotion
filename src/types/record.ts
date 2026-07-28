/**
 * スイング記録 (履歴) の共有型定義
 *
 * 動画ファイルはセッション終了後に失効する (オブジェクト URL が無効になる) ため、
 * 記録として残すのは「骨格線・角度が焼き込み済みの静止画 10 枚 (P1〜P10)」のセット。
 * 保存し直した記録の再解析は行わない。
 *
 * RecordHistory (閲覧 UI) と recordStore (localStorage 永続化) がこの型を介して連携する。
 */

import type { PPointId } from './ppoint';

/** 記録に保存する1枚のP点写真(骨格焼き込み済み) */
export interface RecordFrame {
  id: PPointId;
  timeSec: number;
  /** 骨格・角度が焼き込み済みのJPEG dataURL */
  imageUrl: string;
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
  /** P1〜P10、必ず10件 */
  frames: RecordFrame[];
  /** ユーザーメモ (任意) */
  note?: string;
}
