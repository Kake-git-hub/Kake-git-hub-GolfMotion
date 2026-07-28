import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import type { Club, ClubSet } from '../types/club';
import {
  createClubSet,
  deleteClubSet,
  duplicateClubSet,
  loadClubSets,
  renameClubSet,
  setMainClubSet,
  updateClubSetClubs,
} from '../services/clubSetStore';
import './clubManager.css';

/* =========================================================
   テーブル列定義
   ========================================================= */

/** 文字列 (テキスト直接編集) のフィールド */
type TextField = 'name' | 'head' | 'shaft' | 'balance' | 'trimming' | 'leadAdjustment' | 'underwrap';
/** 数値 (onBlur で parseFloat する) フィールド */
type NumericField = 'lengthInch' | 'totalWeightG' | 'frequencyCpm' | 'loftDeg' | 'lieAngleDeg';

interface ColumnBase {
  label: string;
  sticky?: boolean;
}

interface TextColumn extends ColumnBase {
  key: TextField;
  type: 'text';
}

interface NumericColumn extends ColumnBase {
  key: NumericField;
  type: 'numeric';
}

type ColumnDef = TextColumn | NumericColumn;

/** テーブル列定義 (表示順) */
const COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'クラブ', type: 'text', sticky: true },
  { key: 'head', label: 'ヘッド', type: 'text' },
  { key: 'shaft', label: 'シャフト', type: 'text' },
  { key: 'lengthInch', label: '長さ(inch)', type: 'numeric' },
  { key: 'balance', label: 'バランス', type: 'text' },
  { key: 'totalWeightG', label: '総重量(g)', type: 'numeric' },
  { key: 'frequencyCpm', label: '振動数(cpm)', type: 'numeric' },
  { key: 'loftDeg', label: 'ロフト(°)', type: 'numeric' },
  { key: 'lieAngleDeg', label: 'ライ角(°)', type: 'numeric' },
  { key: 'trimming', label: 'トリミング', type: 'text' },
  { key: 'leadAdjustment', label: '鉛調整', type: 'text' },
  { key: 'underwrap', label: '下巻き', type: 'text' },
];

/** 空のクラブ行を生成 */
function createEmptyClub(): Club {
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `club-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    name: '',
    head: '',
    shaft: '',
    lengthInch: null,
    balance: '',
    totalWeightG: null,
    frequencyCpm: null,
    loftDeg: null,
    lieAngleDeg: null,
    trimming: '',
    leadAdjustment: '',
    underwrap: '',
  };
}

/* =========================================================
   可視化: 配色トークン

   ダークテーマ専用アプリのため、ダークサーフェス (#22223a) 上で
   検証済みのステップのみを使う。カテゴリカル 3 スロットは
   validate_palette.js の --pairs all (散布図で任意の 2 点が隣接しうる)
   を含む全チェックを通過している:
     Lightness / Chroma / CVD ΔE 9.4 / 通常視 ΔE 20.9 / コントラスト >= 3:1
   スロットは「クラブ種別」という実体に固定で紐づき、並び順や本数で
   色が入れ替わることはない。
   ========================================================= */

/** チャートのサーフェス色 (SVG のギャップ/リングもこの色で描く) */
const VIZ_SURFACE = '#22223a';
/** 目盛線 (サーフェスから 1 段だけずらしたヘアライン) */
const VIZ_GRID = '#2e2e45';
/** 軸ルール */
const VIZ_AXIS = '#3d3d5c';
/* 軸ラベル等のインクは clubManager.css の .cm-svg-tick / .cm-svg-label 側で定義する
   (ミュート #9a9ab5 = 5.6:1 / セカンダリ #c9c9dd = 9.5:1、いずれも対サーフェス) */
/** 文脈線 (長さチャートのトレンド線。対サーフェス 4.6:1) */
const VIZ_TREND = '#8a8aa8';

/** クラブ種別 (カテゴリカル配色の実体) */
type ClubFamily = 'wood' | 'iron' | 'wedge' | 'other';

const FAMILY_ORDER: ClubFamily[] = ['wood', 'iron', 'wedge', 'other'];

const FAMILY_META: Record<ClubFamily, { label: string; color: string }> = {
  // カテゴリカル スロット 1〜3 (検証済み)
  wood: { label: 'ウッド・UT', color: '#3987e5' },
  iron: { label: 'アイアン', color: '#d95926' },
  wedge: { label: 'ウェッジ・PT', color: '#199e70' },
  // 「その他」は 4 番目の色相を生成せず、デエンファシスのグレーに畳む
  other: { label: 'その他', color: '#8b8ba7' },
};

/** クラブ名から種別を判定する (先に接頭辞の強い規則から評価する) */
function classifyClub(name: string): ClubFamily {
  const n = name.trim().toUpperCase().replace(/\s+/g, '');
  if (n === '') return 'other';
  // WG50 などは 'W' を含むためウェッジ判定を先に行う
  if (n.startsWith('WG') || n.startsWith('PT') || n.startsWith('PUT')) return 'wedge';
  if (/^(PW|AW|SW|LW|GW|DW)/.test(n)) return 'wedge';
  if (/^I/.test(n)) return 'iron';
  if (/^U/.test(n) || /^H\d/.test(n) || /^\d+H$/.test(n)) return 'wood';
  if (/^\d*W$/.test(n) || /^W\d/.test(n)) return 'wood';
  if (/^\d+I$/.test(n) || /^\d+$/.test(n)) return 'iron';
  return 'other';
}

/* =========================================================
   可視化: 汎用ヘルパー
   ========================================================= */

/**
 * 描画領域の実ピクセル幅を購読する
 *
 * viewBox を実測幅と 1:1 にすることで、スマホでも軸ラベルが
 * 縮小されず意図した文字サイズのまま読める。
 */
function useMeasuredWidth(fallback: number): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(fallback);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const w = el.clientWidth;
      if (w > 0) setWidth(Math.round(w));
    };

    // 初回はレイアウト確定直後に同期計測する。
    // ResizeObserver の初回コールバックはフレーム更新に紐づくため、
    // 非アクティブなタブなどでは遅延しうる (それを待つと fallback 幅で描かれる)。
    measure();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

/** 軸目盛を「切りの良い数値」で生成する */
function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [];

  const rawStep = (max - min) / count;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;
  const niceStep =
    (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10) *
    magnitude;

  const ticks: number[] = [];
  const start = Math.ceil(min / niceStep) * niceStep;
  for (let v = start; v <= max + niceStep * 1e-6; v += niceStep) {
    ticks.push(Math.round(v / niceStep) * niceStep);
  }
  return ticks;
}

/** 値域に余白を付けたドメインを返す */
function paddedDomain(values: number[], padRatio = 0.12): [number, number] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) {
    const delta = Math.abs(min) * 0.1 || 1;
    return [min - delta, max + delta];
  }
  const pad = (max - min) * padRatio;
  return [min - pad, max + pad];
}

/** 小数の余分な 0 を落として整形する */
function formatNumber(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** 上端だけ角丸で、ベースライン側は角のままの矩形パス */
function topRoundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return [
    `M${x},${y + h}`,
    `L${x},${y + rr}`,
    `Q${x},${y} ${x + rr},${y}`,
    `L${x + w - rr},${y}`,
    `Q${x + w},${y} ${x + w},${y + rr}`,
    `L${x + w},${y + h}`,
    'Z',
  ].join(' ');
}

/**
 * カテゴリ軸ラベルの回転/間引きを決める
 *
 * ラベルはクリップさせず必ず読める状態にするため、最長ラベルの実寸を
 * 10px フォントから見積もり、収まらなければ 45 度回転 → それでも
 * 足りなければ間引く、の順で対応する。
 */
function axisLabelPlan(bandWidth: number, names: string[]): { rotate: boolean; step: number } {
  const maxChars = names.reduce((m, n) => Math.max(m, n.length), 1);
  const labelWidth = maxChars * 6.2 + 4;
  const rotate = labelWidth + 8 > bandWidth;
  // 45 度回転時の水平フットプリントは (テキスト幅 + 行高) * cos45
  const needed = rotate ? (labelWidth + 12) * 0.7071 + 4 : labelWidth + 8;
  return { rotate, step: Math.max(1, Math.ceil(needed / Math.max(bandWidth, 1))) };
}

/* =========================================================
   可視化: 共通パーツ
   ========================================================= */

interface TooltipRow {
  label: string;
  value: string;
  color: string;
}

/** マークのホバー/フォーカス時に出る読み取り (値が主・ラベルが従) */
function ChartTooltip({
  x,
  y,
  containerWidth,
  title,
  rows,
}: {
  x: number;
  y: number;
  containerWidth: number;
  title: string;
  rows: TooltipRow[];
}) {
  const clampedX = Math.min(Math.max(x, 62), Math.max(containerWidth - 62, 62));
  return (
    <div className="cm-tip" style={{ left: `${clampedX}px`, top: `${y}px` }} role="status">
      <div className="cm-tip-title">{title}</div>
      {rows.map((row) => (
        <div className="cm-tip-row" key={row.label}>
          <span className="cm-tip-key" style={{ background: row.color }} aria-hidden="true" />
          <span className="cm-tip-value">{row.value}</span>
          <span className="cm-tip-label">{row.label}</span>
        </div>
      ))}
    </div>
  );
}

/** チャート 1 枚分の枠 (見出し + 実測幅を渡す本体) */
function ChartCard({
  title,
  subtitle,
  hasData,
  emptyHint,
  children,
}: {
  title: string;
  subtitle: string;
  hasData: boolean;
  emptyHint: string;
  children: (width: number) => ReactNode;
}) {
  const [ref, width] = useMeasuredWidth(320);

  return (
    <figure className="cm-chart-card">
      <figcaption className="cm-chart-head">
        <h4 className="cm-chart-title">{title}</h4>
        <p className="cm-chart-sub">{subtitle}</p>
      </figcaption>
      <div className="cm-chart-body" ref={ref}>
        {hasData ? children(width) : <p className="cm-chart-empty">{emptyHint}</p>}
      </div>
    </figure>
  );
}

/** クラブ種別の凡例 (この可視化セクション全体で共通の意味づけ) */
function FamilyLegend({ families }: { families: ClubFamily[] }) {
  if (families.length < 2) return null;
  return (
    <ul className="cm-legend">
      {families.map((f) => (
        <li className="cm-legend-item" key={f}>
          <span className="cm-legend-key" style={{ background: FAMILY_META[f].color }} aria-hidden="true" />
          {FAMILY_META[f].label}
        </li>
      ))}
    </ul>
  );
}

/* =========================================================
   可視化: チャート本体
   ========================================================= */

const BAND_PAD = { top: 16, right: 14, bottom: 48, left: 42 };
const CHART_HEIGHT = 210;

/** カテゴリ軸 (クラブ名) の目盛ラベル */
function CategoryAxis({
  names,
  bandWidth,
  left,
  baselineY,
}: {
  names: string[];
  bandWidth: number;
  left: number;
  baselineY: number;
}) {
  const { rotate, step } = axisLabelPlan(bandWidth, names);
  return (
    <g aria-hidden="true">
      {names.map((name, i) => {
        if (i % step !== 0) return null;
        const cx = left + bandWidth * (i + 0.5);
        const y = baselineY + 14;
        return (
          <text
            key={`${name}-${i}`}
            x={cx}
            y={y}
            className="cm-svg-tick"
            textAnchor={rotate ? 'end' : 'middle'}
            transform={rotate ? `rotate(-45 ${cx} ${y})` : undefined}
          >
            {name}
          </text>
        );
      })}
    </g>
  );
}

/** 値軸の目盛線 + ラベル */
function ValueAxis({
  ticks,
  scale,
  left,
  right,
}: {
  ticks: number[];
  scale: (v: number) => number;
  left: number;
  right: number;
}) {
  return (
    <g aria-hidden="true">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={left} x2={right} y1={scale(t)} y2={scale(t)} stroke={VIZ_GRID} strokeWidth={1} />
          <text x={left - 8} y={scale(t) + 3.5} className="cm-svg-tick" textAnchor="end">
            {formatNumber(t)}
          </text>
        </g>
      ))}
    </g>
  );
}

/** 1. ロフト角の推移 — 種別で色分けした縦棒 (ベースライン 0 から伸びる) */
function LoftChart({ clubs, width }: { clubs: Club[]; width: number }) {
  const [hover, setHover] = useState<number | null>(null);

  const plotW = Math.max(width - BAND_PAD.left - BAND_PAD.right, 40);
  const plotH = CHART_HEIGHT - BAND_PAD.top - BAND_PAD.bottom;
  const baselineY = BAND_PAD.top + plotH;
  const bandW = plotW / clubs.length;

  const maxLoft = Math.max(...clubs.map((c) => c.loftDeg ?? 0));
  const ticks = niceTicks(0, maxLoft * 1.08, 4);
  const domainMax = Math.max(ticks[ticks.length - 1] ?? maxLoft, maxLoft) || 1;
  const yScale = (v: number) => baselineY - (v / domainMax) * plotH;

  const barW = Math.min(24, Math.max(bandW * 0.62, 3));
  const hovered = hover !== null ? clubs[hover] : null;

  return (
    <>
      <svg
        width="100%"
        height={CHART_HEIGHT}
        viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
        className="cm-svg"
        role="img"
        aria-label={`クラブ別ロフト角。${clubs.length}本、${formatNumber(
          Math.min(...clubs.map((c) => c.loftDeg ?? 0)),
        )}度から${formatNumber(maxLoft)}度。`}
      >
        <ValueAxis ticks={ticks} scale={yScale} left={BAND_PAD.left} right={BAND_PAD.left + plotW} />
        <line
          x1={BAND_PAD.left}
          x2={BAND_PAD.left + plotW}
          y1={baselineY}
          y2={baselineY}
          stroke={VIZ_AXIS}
          strokeWidth={1}
        />

        {clubs.map((club, i) => {
          const value = club.loftDeg ?? 0;
          const y = yScale(value);
          const cx = BAND_PAD.left + bandW * (i + 0.5);
          const family = classifyClub(club.name);
          return (
            <path
              key={club.id}
              d={topRoundedRectPath(cx - barW / 2, y, barW, baselineY - y, 4)}
              fill={FAMILY_META[family].color}
              opacity={hover === null || hover === i ? 1 : 0.45}
            />
          );
        })}

        <CategoryAxis
          names={clubs.map((c) => c.name || '—')}
          bandWidth={bandW}
          left={BAND_PAD.left}
          baselineY={baselineY}
        />

        {/* 当たり判定: バンド全幅なのでマークより広い */}
        {clubs.map((club, i) => (
          <rect
            key={`hit-${club.id}`}
            x={BAND_PAD.left + bandW * i}
            y={BAND_PAD.top}
            width={bandW}
            height={plotH}
            fill="transparent"
            tabIndex={0}
            role="button"
            aria-label={`${club.name || '名称未設定'} ロフト ${formatNumber(club.loftDeg ?? 0)}度`}
            onPointerEnter={() => setHover(i)}
            onPointerDown={() => setHover(i)}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
          />
        ))}
      </svg>

      {hovered && hover !== null && (
        <ChartTooltip
          x={BAND_PAD.left + bandW * (hover + 0.5)}
          y={Math.max(yScale(hovered.loftDeg ?? 0) - 10, 8)}
          containerWidth={width}
          title={hovered.name || '名称未設定'}
          rows={[
            {
              label: 'ロフト角',
              value: `${formatNumber(hovered.loftDeg ?? 0)}°`,
              color: FAMILY_META[classifyClub(hovered.name)].color,
            },
          ]}
        />
      )}
    </>
  );
}

/** 2. 長さの推移 — 文脈のトレンド線 + 種別で色分けした点 */
function LengthChart({ clubs, width }: { clubs: Club[]; width: number }) {
  const [hover, setHover] = useState<number | null>(null);

  const plotW = Math.max(width - BAND_PAD.left - BAND_PAD.right, 40);
  const plotH = CHART_HEIGHT - BAND_PAD.top - BAND_PAD.bottom;
  const baselineY = BAND_PAD.top + plotH;
  const bandW = plotW / clubs.length;

  const values = clubs.map((c) => c.lengthInch ?? 0);
  const [domainMin, domainMax] = paddedDomain(values);
  const ticks = niceTicks(domainMin, domainMax, 4);
  const yScale = (v: number) => baselineY - ((v - domainMin) / (domainMax - domainMin)) * plotH;
  const xAt = (i: number) => BAND_PAD.left + bandW * (i + 0.5);

  const points = clubs.map((c, i) => `${xAt(i)},${yScale(c.lengthInch ?? 0)}`).join(' ');
  const hovered = hover !== null ? clubs[hover] : null;

  return (
    <>
      <svg
        width="100%"
        height={CHART_HEIGHT}
        viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
        className="cm-svg"
        role="img"
        aria-label={`クラブ別の長さ。${formatNumber(Math.max(...values))}インチから${formatNumber(
          Math.min(...values),
        )}インチへ、番手が上がるほど短くなる。`}
      >
        <ValueAxis ticks={ticks} scale={yScale} left={BAND_PAD.left} right={BAND_PAD.left + plotW} />
        <line
          x1={BAND_PAD.left}
          x2={BAND_PAD.left + plotW}
          y1={baselineY}
          y2={baselineY}
          stroke={VIZ_AXIS}
          strokeWidth={1}
        />

        {clubs.length > 1 && (
          <polyline
            points={points}
            fill="none"
            stroke={VIZ_TREND}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}

        {clubs.map((club, i) => {
          const family = classifyClub(club.name);
          const isHovered = hover === i;
          return (
            <circle
              key={club.id}
              cx={xAt(i)}
              cy={yScale(club.lengthInch ?? 0)}
              r={isHovered ? 6 : 4.5}
              fill={FAMILY_META[family].color}
              stroke={VIZ_SURFACE}
              strokeWidth={2}
            />
          );
        })}

        {/* 直接ラベルは起点の 1 本だけ (0 始まりでない軸の読み取り基準)。
            最短側はカテゴリ軸ラベルと干渉するうえ、レンジは上のサマリーが担う。 */}
        {clubs.length > 1 && (
          <text
            x={xAt(0)}
            y={yScale(values[0]) - 12}
            className="cm-svg-label"
            textAnchor="start"
            aria-hidden="true"
          >
            {formatNumber(values[0])} in
          </text>
        )}

        <CategoryAxis
          names={clubs.map((c) => c.name || '—')}
          bandWidth={bandW}
          left={BAND_PAD.left}
          baselineY={baselineY}
        />

        {clubs.map((club, i) => (
          <rect
            key={`hit-${club.id}`}
            x={BAND_PAD.left + bandW * i}
            y={BAND_PAD.top}
            width={bandW}
            height={plotH}
            fill="transparent"
            tabIndex={0}
            role="button"
            aria-label={`${club.name || '名称未設定'} 長さ ${formatNumber(club.lengthInch ?? 0)}インチ`}
            onPointerEnter={() => setHover(i)}
            onPointerDown={() => setHover(i)}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
          />
        ))}
      </svg>

      {hovered && hover !== null && (
        <ChartTooltip
          x={xAt(hover)}
          y={Math.max(yScale(hovered.lengthInch ?? 0) - 12, 8)}
          containerWidth={width}
          title={hovered.name || '名称未設定'}
          rows={[
            {
              label: '長さ',
              value: `${formatNumber(hovered.lengthInch ?? 0)} in`,
              color: FAMILY_META[classifyClub(hovered.name)].color,
            },
          ]}
        />
      )}
    </>
  );
}

const SCATTER_PAD = { top: 16, right: 16, bottom: 46, left: 46 };

/** 3. 総重量 × 振動数 の相関 — 種別で色分けした散布図 */
function WeightFrequencyChart({ clubs, width }: { clubs: Club[]; width: number }) {
  const [hover, setHover] = useState<number | null>(null);

  const plotW = Math.max(width - SCATTER_PAD.left - SCATTER_PAD.right, 40);
  const plotH = CHART_HEIGHT - SCATTER_PAD.top - SCATTER_PAD.bottom;
  const baselineY = SCATTER_PAD.top + plotH;

  const weights = clubs.map((c) => c.totalWeightG ?? 0);
  const freqs = clubs.map((c) => c.frequencyCpm ?? 0);
  const [xMin, xMax] = paddedDomain(weights, 0.08);
  const [yMin, yMax] = paddedDomain(freqs, 0.12);
  const xTicks = niceTicks(xMin, xMax, 3);
  const yTicks = niceTicks(yMin, yMax, 4);

  const xScale = (v: number) => SCATTER_PAD.left + ((v - xMin) / (xMax - xMin)) * plotW;
  const yScale = (v: number) => baselineY - ((v - yMin) / (yMax - yMin)) * plotH;

  const hovered = hover !== null ? clubs[hover] : null;

  return (
    <>
      <svg
        width="100%"
        height={CHART_HEIGHT}
        viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
        className="cm-svg"
        role="img"
        aria-label={`総重量と振動数の相関。${clubs.length}本を種別ごとに色分けした散布図。`}
      >
        <ValueAxis
          ticks={yTicks}
          scale={yScale}
          left={SCATTER_PAD.left}
          right={SCATTER_PAD.left + plotW}
        />
        <line
          x1={SCATTER_PAD.left}
          x2={SCATTER_PAD.left + plotW}
          y1={baselineY}
          y2={baselineY}
          stroke={VIZ_AXIS}
          strokeWidth={1}
        />

        <g aria-hidden="true">
          {xTicks.map((t) => (
            <text key={t} x={xScale(t)} y={baselineY + 15} className="cm-svg-tick" textAnchor="middle">
              {formatNumber(t)}
            </text>
          ))}
          <text
            x={SCATTER_PAD.left + plotW / 2}
            y={CHART_HEIGHT - 6}
            className="cm-svg-axis-title"
            textAnchor="middle"
          >
            総重量 (g)
          </text>
          <text
            x={12}
            y={SCATTER_PAD.top + plotH / 2}
            className="cm-svg-axis-title"
            textAnchor="middle"
            transform={`rotate(-90 12 ${SCATTER_PAD.top + plotH / 2})`}
          >
            振動数 (cpm)
          </text>
        </g>

        {clubs.map((club, i) => {
          const family = classifyClub(club.name);
          const isHovered = hover === i;
          return (
            <circle
              key={club.id}
              cx={xScale(club.totalWeightG ?? 0)}
              cy={yScale(club.frequencyCpm ?? 0)}
              r={isHovered ? 7 : 5}
              fill={FAMILY_META[family].color}
              stroke={VIZ_SURFACE}
              strokeWidth={2}
              opacity={hover === null || isHovered ? 1 : 0.5}
            />
          );
        })}

        {/* 点は小さいので当たり判定は直径 28px 相当まで広げる */}
        {clubs.map((club, i) => (
          <circle
            key={`hit-${club.id}`}
            cx={xScale(club.totalWeightG ?? 0)}
            cy={yScale(club.frequencyCpm ?? 0)}
            r={14}
            fill="transparent"
            tabIndex={0}
            role="button"
            aria-label={`${club.name || '名称未設定'} 総重量 ${formatNumber(
              club.totalWeightG ?? 0,
            )}グラム 振動数 ${formatNumber(club.frequencyCpm ?? 0)}cpm`}
            onPointerEnter={() => setHover(i)}
            onPointerDown={() => setHover(i)}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
          />
        ))}
      </svg>

      {hovered && (
        <ChartTooltip
          x={xScale(hovered.totalWeightG ?? 0)}
          y={Math.max(yScale(hovered.frequencyCpm ?? 0) - 14, 8)}
          containerWidth={width}
          title={hovered.name || '名称未設定'}
          rows={[
            {
              label: '総重量',
              value: `${formatNumber(hovered.totalWeightG ?? 0)} g`,
              color: FAMILY_META[classifyClub(hovered.name)].color,
            },
            {
              label: '振動数',
              value: `${formatNumber(hovered.frequencyCpm ?? 0)} cpm`,
              color: FAMILY_META[classifyClub(hovered.name)].color,
            },
          ]}
        />
      )}
    </>
  );
}

/** セット全体のサマリー (数値そのものが答えになるものはチャートにしない) */
function SetSummary({ clubs }: { clubs: Club[] }) {
  const lengths = clubs.map((c) => c.lengthInch).filter((v): v is number => v !== null);
  const weights = clubs.map((c) => c.totalWeightG).filter((v): v is number => v !== null);

  const range = (values: number[], unit: string): string =>
    values.length === 0
      ? '—'
      : `${formatNumber(Math.min(...values))}–${formatNumber(Math.max(...values))} ${unit}`;

  return (
    <div className="cm-stats">
      <div className="cm-stat">
        <span className="cm-stat-label">本数</span>
        <span className="cm-stat-value">{clubs.length}</span>
      </div>
      <div className="cm-stat">
        <span className="cm-stat-label">長さ</span>
        <span className="cm-stat-value cm-stat-value-sm">{range(lengths, 'in')}</span>
      </div>
      <div className="cm-stat">
        <span className="cm-stat-label">総重量</span>
        <span className="cm-stat-value cm-stat-value-sm">{range(weights, 'g')}</span>
      </div>
    </div>
  );
}

/** 可視化セクション全体 */
function VisualizationSection({ clubs }: { clubs: Club[] }) {
  const loftClubs = useMemo(() => clubs.filter((c) => c.loftDeg !== null), [clubs]);
  const lengthClubs = useMemo(() => clubs.filter((c) => c.lengthInch !== null), [clubs]);
  const scatterClubs = useMemo(
    () => clubs.filter((c) => c.totalWeightG !== null && c.frequencyCpm !== null),
    [clubs],
  );

  // 凡例には実際にプロットされている種別だけを出す
  const families = useMemo(() => {
    const present = new Set<ClubFamily>();
    for (const c of [...loftClubs, ...lengthClubs, ...scatterClubs]) {
      present.add(classifyClub(c.name));
    }
    return FAMILY_ORDER.filter((f) => present.has(f));
  }, [loftClubs, lengthClubs, scatterClubs]);

  return (
    <section className="cm-viz" aria-label="セッティングの可視化">
      <header className="cm-section-head">
        <h3 className="cm-section-title">セッティングの流れ</h3>
        <p className="cm-section-note">上の表の値をそのまま図にしています</p>
      </header>

      <SetSummary clubs={clubs} />
      <FamilyLegend families={families} />

      <div className="cm-chart-grid">
        <ChartCard
          title="ロフト角"
          subtitle="番手ごとの角度 (°)"
          hasData={loftClubs.length > 0}
          emptyHint="ロフト角が未入力です。表に値を入れると図が出ます。"
        >
          {(w) => <LoftChart clubs={loftClubs} width={w} />}
        </ChartCard>

        <ChartCard
          title="長さ"
          subtitle="番手が上がるほど短くなる (inch)"
          hasData={lengthClubs.length > 0}
          emptyHint="長さが未入力です。表に値を入れると図が出ます。"
        >
          {(w) => <LengthChart clubs={lengthClubs} width={w} />}
        </ChartCard>

        <ChartCard
          title="総重量 × 振動数"
          subtitle="重いクラブほど硬い (cpm) 傾向"
          hasData={scatterClubs.length > 0}
          emptyHint="総重量と振動数の両方が入ったクラブがありません。"
        >
          {(w) => <WeightFrequencyChart clubs={scatterClubs} width={w} />}
        </ChartCard>
      </div>
    </section>
  );
}

/* =========================================================
   セット一覧カード
   ========================================================= */

function SetCard({
  set,
  isSelected,
  isRenaming,
  renameDraft,
  onSelect,
  onSetMain,
  onDuplicate,
  onStartRename,
  onRenameDraft,
  onCommitRename,
  onCancelRename,
  onDelete,
}: {
  set: ClubSet;
  isSelected: boolean;
  isRenaming: boolean;
  renameDraft: string;
  onSelect: () => void;
  onSetMain: () => void;
  onDuplicate: () => void;
  onStartRename: () => void;
  onRenameDraft: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onDelete: () => void;
}) {
  const className = [
    'cm-set-card',
    isSelected ? 'cm-set-card-selected' : '',
    set.isMain ? 'cm-set-card-main' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <li className={className}>
      {isRenaming ? (
        <input
          className="cm-set-rename"
          value={renameDraft}
          autoFocus
          aria-label="セット名"
          onChange={(e) => onRenameDraft(e.target.value)}
          onBlur={onCommitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCommitRename();
            if (e.key === 'Escape') onCancelRename();
          }}
        />
      ) : (
        <button type="button" className="cm-set-open" onClick={onSelect} aria-pressed={isSelected}>
          <span className="cm-set-name">{set.name}</span>
          <span className="cm-set-meta">
            {set.isMain && <span className="cm-set-badge">メイン</span>}
            <span className="cm-set-count">{set.clubs.length}本</span>
          </span>
        </button>
      )}

      <div className="cm-set-actions">
        {!set.isMain && (
          <button type="button" className="cm-chip cm-chip-main" onClick={onSetMain}>
            メインに設定
          </button>
        )}
        <button type="button" className="cm-chip" onClick={onStartRename} aria-label="名前を変更">
          ✎
        </button>
        <button type="button" className="cm-chip" onClick={onDuplicate} aria-label="複製">
          ⧉
        </button>
        <button type="button" className="cm-chip cm-chip-danger" onClick={onDelete} aria-label="削除">
          ✕
        </button>
      </div>
    </li>
  );
}

/* =========================================================
   メイン
   ========================================================= */

/**
 * クラブセッティング管理画面
 *
 * props 無しの自己完結コンポーネント。
 * A. セット一覧 / B. 選択中セットのクラブ編集 / C. 可視化 の 3 領域から成り、
 * 編集はすべて localStorage (clubSetStore) に即時反映される。
 */
export default function ClubManager() {
  const [sets, setSets] = useState<ClubSet[]>(() => loadClubSets());
  const [selectedId, setSelectedId] = useState<string>(
    () => sets.find((s) => s.isMain)?.id ?? sets[0]?.id ?? '',
  );
  // 数値セルの編集中テキスト ('3.' のような未確定入力を保持) key: `${clubId}:${field}`
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  /** ストアから読み直し、選択中セットが消えていれば選択を寄せる */
  const refresh = useCallback((preferId?: string) => {
    const next = loadClubSets();
    setSets(next);
    setSelectedId((prev) => {
      const want = preferId ?? prev;
      if (next.some((s) => s.id === want)) return want;
      return next.find((s) => s.isMain)?.id ?? next[0]?.id ?? '';
    });
  }, []);

  const selectedSet = sets.find((s) => s.id === selectedId) ?? sets[0] ?? null;
  const clubs = useMemo(() => selectedSet?.clubs ?? [], [selectedSet]);

  /* ----- セット操作 ----- */

  function handleCreateSet() {
    const name = window.prompt('新しいセットの名前', '新しいセット');
    if (name === null || name.trim() === '') return;
    const created = createClubSet(name.trim());
    refresh(created.id);
  }

  function handleDuplicate(set: ClubSet) {
    const copy = duplicateClubSet(set.id);
    if (copy) refresh(copy.id);
  }

  function handleSetMain(set: ClubSet) {
    setMainClubSet(set.id);
    refresh();
  }

  function handleDelete(set: ClubSet) {
    if (sets.length <= 1) {
      window.alert('セットは最低 1 つ必要です。これ以上削除できません。');
      return;
    }
    if (!window.confirm(`「${set.name}」を削除しますか？この操作は取り消せません。`)) return;
    if (!deleteClubSet(set.id)) {
      window.alert('セットを削除できませんでした。');
      return;
    }
    refresh();
  }

  function handleStartRename(set: ClubSet) {
    setRenamingId(set.id);
    setRenameDraft(set.name);
  }

  function handleCommitRename() {
    if (renamingId === null) return;
    const trimmed = renameDraft.trim();
    if (trimmed !== '') renameClubSet(renamingId, trimmed);
    setRenamingId(null);
    setRenameDraft('');
    refresh();
  }

  function handleCancelRename() {
    setRenamingId(null);
    setRenameDraft('');
  }

  /* ----- クラブ編集 ----- */

  /** クラブ配列を差し替えてローカル state と localStorage を同時に更新 */
  function commitClubs(nextClubs: Club[]) {
    if (!selectedSet) return;
    const targetId = selectedSet.id;
    const now = Date.now();
    setSets((prev) =>
      prev.map((s) => (s.id === targetId ? { ...s, clubs: nextClubs, updatedAt: now } : s)),
    );
    updateClubSetClubs(targetId, nextClubs);
  }

  function updateClub(id: string, patch: Partial<Club>) {
    commitClubs(clubs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  function handleTextChange(id: string, field: TextField, value: string) {
    updateClub(id, { [field]: value } as Partial<Club>);
  }

  /** 数値系は確定するまで文字列のままバッファに保持する */
  function handleNumericChange(id: string, field: NumericField, value: string) {
    setDrafts((prev) => ({ ...prev, [`${id}:${field}`]: value }));
  }

  /** フォーカスアウトで parseFloat して確定 */
  function handleNumericBlur(id: string, field: NumericField) {
    const key = `${id}:${field}`;
    if (!(key in drafts)) return;

    const trimmed = drafts[key].trim();
    const parsed = trimmed === '' ? null : parseFloat(trimmed);
    const finalValue = parsed === null || Number.isNaN(parsed) ? null : parsed;

    updateClub(id, { [field]: finalValue } as Partial<Club>);
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function getNumericDisplay(club: Club, field: NumericField): string {
    const key = `${club.id}:${field}`;
    if (key in drafts) return drafts[key];
    const value = club[field];
    return value === null ? '' : String(value);
  }

  function handleAddClub() {
    commitClubs([...clubs, createEmptyClub()]);
  }

  function handleDeleteClub(club: Club) {
    const label = club.name.trim() || '(名称未設定)';
    if (!window.confirm(`「${label}」を削除しますか？`)) return;

    commitClubs(clubs.filter((c) => c.id !== club.id));
    setDrafts((prev) => {
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (!k.startsWith(`${club.id}:`)) next[k] = v;
      }
      return next;
    });
  }

  /* ----- 描画 ----- */

  return (
    <div className="cm-container">
      <header className="cm-header">
        <h2 className="cm-title">🏌️ クラブセッティング</h2>
        <span className="cm-header-note">
          メインセットが解析画面で使われます
        </span>
      </header>

      {/* A. セット一覧 */}
      <section className="cm-sets" aria-label="クラブセット一覧">
        <div className="cm-section-head">
          <h3 className="cm-section-title">セット</h3>
          <button type="button" className="cm-new-set-btn" onClick={handleCreateSet}>
            + 新しいセット
          </button>
        </div>
        <ul className="cm-set-rail">
          {sets.map((set) => (
            <SetCard
              key={set.id}
              set={set}
              isSelected={set.id === selectedSet?.id}
              isRenaming={renamingId === set.id}
              renameDraft={renameDraft}
              onSelect={() => setSelectedId(set.id)}
              onSetMain={() => handleSetMain(set)}
              onDuplicate={() => handleDuplicate(set)}
              onStartRename={() => handleStartRename(set)}
              onRenameDraft={setRenameDraft}
              onCommitRename={handleCommitRename}
              onCancelRename={handleCancelRename}
              onDelete={() => handleDelete(set)}
            />
          ))}
        </ul>
      </section>

      {selectedSet && (
        <>
          {/* B. 選択中セットのクラブ編集 */}
          <section className="cm-editor" aria-label="クラブ編集">
            <div className="cm-section-head">
              <h3 className="cm-section-title">
                {selectedSet.name}
                {selectedSet.isMain && <span className="cm-set-badge cm-set-badge-inline">メイン</span>}
              </h3>
              <span className={`cm-count ${clubs.length === 14 ? '' : 'cm-count-warn'}`}>
                {clubs.length}本
              </span>
            </div>

            <div className="cm-table-wrap">
              <table className="cm-table">
                <thead>
                  <tr>
                    {COLUMNS.map((col) => (
                      <th key={col.key} className={`cm-th ${col.sticky ? 'cm-th-sticky' : ''}`}>
                        {col.label}
                      </th>
                    ))}
                    <th className="cm-th cm-th-delete">削除</th>
                  </tr>
                </thead>
                <tbody>
                  {clubs.map((club) => (
                    <tr key={club.id} className="cm-row">
                      {COLUMNS.map((col) => {
                        const cellClass = [
                          'cm-cell',
                          col.type === 'numeric' ? 'cm-cell-numeric' : '',
                          col.sticky ? 'cm-cell-sticky' : '',
                        ]
                          .filter(Boolean)
                          .join(' ');

                        return (
                          <td key={col.key} className={cellClass}>
                            {col.type === 'text' ? (
                              <input
                                type="text"
                                className="cm-input"
                                aria-label={`${club.name || 'クラブ'} ${col.label}`}
                                value={club[col.key]}
                                onChange={(e) => handleTextChange(club.id, col.key, e.target.value)}
                              />
                            ) : (
                              <input
                                type="text"
                                inputMode="decimal"
                                className="cm-input cm-input-numeric"
                                aria-label={`${club.name || 'クラブ'} ${col.label}`}
                                value={getNumericDisplay(club, col.key)}
                                onChange={(e) =>
                                  handleNumericChange(club.id, col.key, e.target.value)
                                }
                                onBlur={() => handleNumericBlur(club.id, col.key)}
                              />
                            )}
                          </td>
                        );
                      })}
                      <td className="cm-cell cm-cell-delete">
                        <button
                          type="button"
                          className="cm-delete-btn"
                          aria-label={`${club.name || 'クラブ'}を削除`}
                          onClick={() => handleDeleteClub(club)}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <button type="button" className="cm-add-btn" onClick={handleAddClub}>
              + クラブ追加
            </button>
          </section>

          {/* C. 可視化 */}
          <VisualizationSection clubs={clubs} />
        </>
      )}
    </div>
  );
}
