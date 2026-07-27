import type { Club } from '../types/club';

/**
 * クラブセッティングの初期データ (14本)
 *
 * ユーザーの実測値。id は name と同じ文字列を用いる。
 */
export const DEFAULT_CLUBS: Club[] = [
  {
    id: '1W', name: '1W', head: 'Qi10', shaft: 'TM-50 S',
    lengthInch: 45.625, balance: 'D0.6', totalWeightG: 311, frequencyCpm: 237,
    loftDeg: null, lieAngleDeg: null, trimming: '', leadAdjustment: '', underwrap: '',
  },
  {
    id: '3W', name: '3W', head: 'Qi10', shaft: 'TM-50 S',
    lengthInch: 43.5, balance: 'D0.5', totalWeightG: 323, frequencyCpm: 245,
    loftDeg: null, lieAngleDeg: null, trimming: '', leadAdjustment: '', underwrap: '',
  },
  {
    id: '5W', name: '5W', head: 'Qi10', shaft: 'TM-50 S',
    lengthInch: 42.325, balance: 'D0', totalWeightG: 328, frequencyCpm: 250,
    loftDeg: null, lieAngleDeg: null, trimming: '', leadAdjustment: '', underwrap: '',
  },
  {
    id: 'U22', name: 'U22', head: 'G430', shaft: 'HY-65 S',
    lengthInch: 40, balance: 'D0.9', totalWeightG: 354, frequencyCpm: 281,
    loftDeg: null, lieAngleDeg: null, trimming: '', leadAdjustment: '', underwrap: '',
  },
  {
    id: 'U26', name: 'U26', head: 'G430', shaft: 'HY-75 S',
    lengthInch: 39.25, balance: 'D1', totalWeightG: 367, frequencyCpm: 287,
    loftDeg: null, lieAngleDeg: null, trimming: '', leadAdjustment: '', underwrap: '',
  },
  {
    id: 'I#6', name: 'I#6', head: 'AF-506', shaft: 'NEO950 SR',
    lengthInch: 38, balance: 'D2', totalWeightG: 411, frequencyCpm: 314,
    loftDeg: 27.5, lieAngleDeg: 62, trimming: '', leadAdjustment: '', underwrap: '',
  },
  {
    id: 'I#7', name: 'I#7', head: 'AF-506', shaft: 'NEO950 SR',
    lengthInch: 37.325, balance: 'D1.8', totalWeightG: 416, frequencyCpm: 322,
    loftDeg: 31, lieAngleDeg: 62.5, trimming: '', leadAdjustment: '', underwrap: '',
  },
  {
    id: 'I#8', name: 'I#8', head: 'AF-506', shaft: 'NEO950 SR',
    lengthInch: 36.75, balance: 'D2.1', totalWeightG: 425, frequencyCpm: 329,
    loftDeg: 35, lieAngleDeg: 63, trimming: '', leadAdjustment: '', underwrap: '',
  },
  {
    id: 'I#9', name: 'I#9', head: 'AF-506', shaft: 'NEO950 SR',
    lengthInch: 36.25, balance: 'D2', totalWeightG: 430, frequencyCpm: 335,
    loftDeg: 40, lieAngleDeg: 63.5, trimming: '', leadAdjustment: '', underwrap: '',
  },
  {
    id: 'I#P', name: 'I#P', head: 'AF-506', shaft: 'NEO950 SR',
    lengthInch: 35.75, balance: 'D1.7', totalWeightG: 440, frequencyCpm: 344,
    loftDeg: 45, lieAngleDeg: 64, trimming: '', leadAdjustment: '', underwrap: '',
  },
  {
    id: 'WG50', name: 'WG50', head: 'エポンWG', shaft: 'モーダス120 S',
    lengthInch: 35.5, balance: 'D3', totalWeightG: 455, frequencyCpm: 348,
    loftDeg: 50, lieAngleDeg: 64, trimming: '', leadAdjustment: '', underwrap: '',
  },
  {
    id: 'WG56', name: 'WG56', head: 'エポンWG', shaft: 'モーダス120 S',
    lengthInch: 35.25, balance: 'D3', totalWeightG: 458, frequencyCpm: 349,
    loftDeg: 56, lieAngleDeg: 64, trimming: '', leadAdjustment: '外+1.5g', underwrap: '',
  },
  {
    id: 'WG60', name: 'WG60', head: 'エポンWG', shaft: 'モーダス120 S',
    lengthInch: 35.125, balance: 'D3', totalWeightG: 460, frequencyCpm: 350,
    loftDeg: 60, lieAngleDeg: 64, trimming: '', leadAdjustment: '', underwrap: '',
  },
  // パター: 元表に記載なし、ユーザーが後で入力する空欄プレースホルダ
  {
    id: 'PT', name: 'PT', head: '', shaft: '',
    lengthInch: null, balance: '', totalWeightG: null, frequencyCpm: null,
    loftDeg: null, lieAngleDeg: null, trimming: '', leadAdjustment: '', underwrap: '',
  },
];
