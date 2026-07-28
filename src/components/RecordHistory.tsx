import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  CSSProperties,
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import type { Club } from '../types/club';
import type { PPointId } from '../types/ppoint';
import { P_POINT_IDS, P_POINT_INFO } from '../types/ppoint';
import type { AngleKey, RecordFrame, SwingRecord } from '../types/record';
import { ANGLE_KEYS, ANGLE_LABELS } from '../types/record';
import { deleteRecord, listRecords, updateRecordNote } from '../services/recordStore';
import './recordHistory.css';

/** 一覧カードのサムネイルに出す代表 P 点 (アドレス / トップ / インパクト / フィニッシュ) */
const THUMB_IDS: PPointId[] = ['P1', 'P4', 'P7', 'P10'];

/** スワイプと判定する横移動量 (px)。これ未満はタップ扱い */
const SWIPE_THRESHOLD_PX = 40;

/* =========================================================
   角度グラフの配色 / 形状 (dataviz スキル準拠)
   ========================================================= */

/**
 * グラフのプロット面の色。
 * CSS 側 (.rh-chart-plot の背景) と必ず同じ値にすること。
 * マーカーの「サーフェスリング」もこの色で描く。
 */
const CHART_SURFACE = '#1a1a28';

/**
 * 系列色 = dataviz スキルの dark カテゴリカル slot1〜6 を ANGLE_KEYS の並び順に固定割当。
 * 順番自体が CVD 安全性の担保なので、系列が減っても色は付け替えない (色は関節に固定)。
 */
const SERIES_COLOR: Record<AngleKey, string> = {
  shoulder: '#3987e5',   // slot1 blue
  hip: '#d95926',        // slot2 orange
  leftElbow: '#199e70',  // slot3 aqua
  rightElbow: '#c98500', // slot4 yellow
  leftKnee: '#d55181',   // slot5 magenta
  rightKnee: '#008300',  // slot6 green
};

/** マーカー形状 (色だけに頼らないための第 2 チャネル。折れ線が交差しても識別できる) */
type MarkerShape = 'circle' | 'square' | 'diamond' | 'triangleUp' | 'triangleDown' | 'hexagon';

const SERIES_SHAPE: Record<AngleKey, MarkerShape> = {
  shoulder: 'circle',
  hip: 'square',
  leftElbow: 'diamond',
  rightElbow: 'triangleUp',
  leftKnee: 'triangleDown',
  rightKnee: 'hexagon',
};

/** 小数を丸めて SVG のパス文字列を短く保つ */
function q(v: number): number {
  return Math.round(v * 10) / 10;
}

/** マーカー 1 個分の SVG パス (中心 cx,cy / 外接半径 r) */
function markerPath(shape: MarkerShape, cx: number, cy: number, r: number): string {
  const x = q(cx);
  const y = q(cy);
  switch (shape) {
    case 'square':
      return `M${q(x - r * 0.88)},${q(y - r * 0.88)}h${q(r * 1.76)}v${q(r * 1.76)}h${q(-r * 1.76)}Z`;
    case 'diamond':
      return `M${x},${q(y - r * 1.2)}L${q(x + r * 1.2)},${y}L${x},${q(y + r * 1.2)}L${q(x - r * 1.2)},${y}Z`;
    case 'triangleUp':
      return `M${x},${q(y - r * 1.2)}L${q(x + r * 1.1)},${q(y + r * 0.8)}L${q(x - r * 1.1)},${q(y + r * 0.8)}Z`;
    case 'triangleDown':
      return `M${x},${q(y + r * 1.2)}L${q(x + r * 1.1)},${q(y - r * 0.8)}L${q(x - r * 1.1)},${q(y - r * 0.8)}Z`;
    case 'hexagon': {
      const pts: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const a = (Math.PI / 3) * i - Math.PI / 2;
        pts.push(`${q(x + r * Math.cos(a))},${q(y + r * Math.sin(a))}`);
      }
      return `M${pts.join('L')}Z`;
    }
    case 'circle':
    default:
      return `M${q(x - r)},${y}a${r},${r} 0 1 0 ${q(r * 2)},0a${r},${r} 0 1 0 ${q(-r * 2)},0Z`;
  }
}

/* =========================================================
   小さなユーティリティ
   ========================================================= */

/** epoch ms → "2026/07/28 14:32" */
function formatDateTime(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '日時不明';

  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** そのフレームが角度データを持っているか */
function hasAngles(frame: RecordFrame): boolean {
  return frame.angles !== undefined && Object.keys(frame.angles).length > 0;
}

/** 記録全体で角度データが 1 つでもあるか (一覧のバッジ判定にも使う) */
function recordHasAngles(record: SwingRecord): boolean {
  return record.frames.some(hasAngles);
}

/** フレームを P1→P10 の順に並べ替える (保存順が崩れた旧データ対策) */
function orderFrames(frames: RecordFrame[]): RecordFrame[] {
  const byId = new Map<PPointId, RecordFrame>();
  for (const f of frames) if (!byId.has(f.id)) byId.set(f.id, f);

  return P_POINT_IDS.map((id) => byId.get(id)).filter(
    (f): f is RecordFrame => f !== undefined,
  );
}

/** 軸の目盛りをキリの良い値に丸める */
function niceScale(min: number, max: number, targetTicks = 4): { lo: number; hi: number; ticks: number[] } {
  let lo = min;
  let hi = max;
  if (!(hi > lo)) {
    // 全点が同値 → 前後に少し余白を作る
    lo = min - 5;
    hi = max + 5;
  }

  const rawStep = (hi - lo) / targetTicks;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const norm = rawStep / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;

  const niceLo = Math.floor(lo / step) * step;
  let niceHi = Math.ceil(hi / step) * step;
  if (niceHi <= niceLo) niceHi = niceLo + step;

  const ticks: number[] = [];
  for (let v = niceLo; v <= niceHi + step * 0.001; v += step) {
    ticks.push(Math.round(v * 1000) / 1000);
  }
  return { lo: niceLo, hi: niceHi, ticks };
}

/* =========================================================
   クラブ情報パネル
   ========================================================= */

interface SpecRow {
  label: string;
  value: string;
}

/** Club から表示行を組み立てる。空文字 / null の項目は行ごと省く */
function buildClubRows(club: Club): SpecRow[] {
  const rows: SpecRow[] = [];

  const pushText = (label: string, v: string) => {
    if (v.trim() !== '') rows.push({ label, value: v.trim() });
  };
  const pushNum = (label: string, v: number | null, unit: string) => {
    if (v !== null && Number.isFinite(v)) rows.push({ label, value: `${v}${unit}` });
  };

  pushText('クラブ名', club.name);
  pushText('ヘッド', club.head);
  pushText('シャフト', club.shaft);
  pushNum('長さ', club.lengthInch, ' inch');
  pushText('バランス', club.balance);
  pushNum('総重量', club.totalWeightG, ' g');
  pushNum('振動数', club.frequencyCpm, ' cpm');
  pushNum('ロフト', club.loftDeg, '°');
  pushNum('ライ角', club.lieAngleDeg, '°');
  pushText('トリミング', club.trimming);
  pushText('鉛調整', club.leadAdjustment);
  pushText('下巻き', club.underwrap);

  return rows;
}

/** 使用クラブのスペック表示。club が無い旧データは名前とヘッドだけ出す */
function ClubSpecPanel({ record }: { record: SwingRecord }): JSX.Element {
  const rows = record.club != null ? buildClubRows(record.club) : [];

  // --- 新データ: 全スペックを定義リストで ---
  if (rows.length > 0) {
    return (
      <section className="rh-spec">
        <h3 className="rh-section-title">使用クラブ</h3>
        <dl className="rh-spec-list">
          {rows.map((row) => (
            <div className="rh-spec-row" key={row.label}>
              <dt className="rh-spec-label">{row.label}</dt>
              <dd className="rh-spec-value">{row.value}</dd>
            </div>
          ))}
        </dl>
      </section>
    );
  }

  // --- 旧データ: スナップショットされた名前 / ヘッドのみ ---
  const name = record.clubName.trim();
  const head = record.clubHead.trim();

  return (
    <section className="rh-spec">
      <h3 className="rh-section-title">使用クラブ</h3>
      {name === '' && head === '' ? (
        <p className="rh-spec-none">クラブ未選択</p>
      ) : (
        <dl className="rh-spec-list">
          {name !== '' && (
            <div className="rh-spec-row">
              <dt className="rh-spec-label">クラブ名</dt>
              <dd className="rh-spec-value">{name}</dd>
            </div>
          )}
          {head !== '' && (
            <div className="rh-spec-row">
              <dt className="rh-spec-label">ヘッド</dt>
              <dd className="rh-spec-value">{head}</dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}

/* =========================================================
   写真ページャ (1 枚を大きく / タップ・スワイプ・矢印キーで移動)
   ========================================================= */

interface PhotoPagerProps {
  frames: RecordFrame[];
  index: number;
  onIndexChange: (next: number) => void;
  onZoom: (url: string) => void;
}

function PhotoPager({ frames, index, onIndexChange, onZoom }: PhotoPagerProps): JSX.Element | null {
  // ポインタ押下位置 (スワイプ量の判定用)
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);

  const last = frames.length - 1;
  const current = frames[index];

  /** 端では止まる (ループしない) */
  const step = useCallback(
    (delta: number) => {
      const next = Math.max(0, Math.min(last, index + delta));
      if (next !== index) onIndexChange(next);
    },
    [index, last, onIndexChange],
  );

  const handlePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    // 指が要素外へ出ても pointerup を受け取れるようにする (取得できなくても支障は無い)
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 取得不能なポインタは無視 */
    }
  }, []);

  const handlePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const start = dragStartRef.current;
      dragStartRef.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      if (start === null) return;

      const dx = e.clientX - start.x;
      if (Math.abs(dx) > SWIPE_THRESHOLD_PX) {
        // 横スワイプ: 左へ払えば次、右へ払えば前
        step(dx < 0 ? 1 : -1);
        return;
      }

      // タップ: 左半分で前、右半分で次
      const rect = e.currentTarget.getBoundingClientRect();
      step(e.clientX - rect.left < rect.width / 2 ? -1 : 1);
    },
    [step],
  );

  const handlePointerCancel = useCallback(() => {
    dragStartRef.current = null;
  }, []);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        step(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        step(1);
      }
    },
    [step],
  );

  if (current === undefined) return null;

  const info = P_POINT_INFO[current.id];
  const stageStyle = { '--rh-color': info.color } as CSSProperties;
  const angleEntries = ANGLE_KEYS.filter((k) => current.angles?.[k] !== undefined);

  return (
    <section className="rh-pager" style={stageStyle}>
      {/* --- 現在の P 点ラベル / 時刻 / 拡大ボタン --- */}
      <div className="rh-pager-head">
        <span className="rh-pager-label">{info.label}</span>
        <span className="rh-pager-time">{current.timeSec.toFixed(2)}s</span>
        <span className="rh-pager-pos">
          {index + 1} / {frames.length}
        </span>
        <button
          type="button"
          className="rh-pager-zoom"
          title="全画面で拡大"
          aria-label="全画面で拡大"
          onClick={() => onZoom(current.imageUrl)}
        >
          ⤢
        </button>
      </div>

      {/* --- 写真本体 (左半分=前 / 右半分=次 / 横スワイプ / ←→ キー) --- */}
      <div
        className="rh-pager-stage"
        role="group"
        aria-label="P 点写真。左右のタップ、横スワイプ、左右矢印キーで移動できます"
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onKeyDown={handleKeyDown}
      >
        <img
          className="rh-pager-img"
          src={current.imageUrl}
          alt={info.label}
          draggable={false}
        />
        <span
          className={`rh-pager-arrow rh-pager-arrow--prev${index === 0 ? ' rh-pager-arrow--off' : ''}`}
          aria-hidden="true"
        >
          ‹
        </span>
        <span
          className={`rh-pager-arrow rh-pager-arrow--next${index === last ? ' rh-pager-arrow--off' : ''}`}
          aria-hidden="true"
        >
          ›
        </span>
      </div>

      {/* --- そのコマの角度 (グラフを見なくても数値が読める) --- */}
      {angleEntries.length > 0 && (
        <div className="rh-pager-angles">
          {angleEntries.map((key) => (
            <span className="rh-angle-chip" key={key}>
              <span
                className="rh-angle-chip-dot"
                style={{ background: SERIES_COLOR[key] }}
                aria-hidden="true"
              />
              <span className="rh-angle-chip-name">{ANGLE_LABELS[key]}</span>
              <span className="rh-angle-chip-value">
                {(current.angles?.[key] ?? 0).toFixed(0)}°
              </span>
            </span>
          ))}
        </div>
      )}

      {/* --- P1〜P10 のチップ列 (現在位置の表示 + ジャンプ) --- */}
      <div className="rh-pager-chips">
        {frames.map((frame, i) => {
          const chipInfo = P_POINT_INFO[frame.id];
          const chipStyle = { '--rh-color': chipInfo.color } as CSSProperties;
          const active = i === index;

          return (
            <button
              type="button"
              key={frame.id}
              className={`rh-pager-chip${active ? ' rh-pager-chip--active' : ''}`}
              style={chipStyle}
              title={chipInfo.label}
              aria-label={chipInfo.label}
              aria-current={active ? 'true' : undefined}
              onClick={() => onIndexChange(i)}
            >
              {chipInfo.short}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* =========================================================
   関節角度グラフ (インライン SVG / 実測ピクセル幅)
   ========================================================= */

interface ChartSeries {
  key: AngleKey;
  values: (number | null)[];
}

function AngleChart({
  frames,
  activeFrameIndex,
  onPickFrame,
}: {
  frames: RecordFrame[];
  activeFrameIndex: number;
  onPickFrame: (index: number) => void;
}): JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [tipIndex, setTipIndex] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  // 親要素の実測幅に追随する (viewBox スケーリングだと軸ラベルが潰れるため)
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (el === null) return;

    let raf = 0;
    let retries = 0;
    const measure = () => {
      const w = el.clientWidth;
      setWidth(w);
      // マウント直後にレイアウトが確定しておらず 0 になることがある。
      // 0 のままだとグラフが一切描かれないので、数フレームだけ測り直す。
      if (w === 0 && retries < 10) {
        retries += 1;
        raf = requestAnimationFrame(measure);
      }
    };
    measure();

    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // ResizeObserver が動かない環境向けの保険 (端末の回転など)
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, []);

  // 全フレームで欠落している系列は描画しない
  const series = useMemo<ChartSeries[]>(
    () =>
      ANGLE_KEYS.map((key) => ({
        key,
        values: frames.map((f) => {
          const v = f.angles?.[key];
          return typeof v === 'number' && Number.isFinite(v) ? v : null;
        }),
      })).filter((s) => s.values.some((v) => v !== null)),
    [frames],
  );

  const scale = useMemo(() => {
    const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
    if (all.length === 0) return niceScale(0, 180);
    return niceScale(Math.min(...all), Math.max(...all));
  }, [series]);

  // 角度データがまったく無い旧記録
  if (series.length === 0) {
    return (
      <section className="rh-chart">
        <h3 className="rh-section-title">関節角度</h3>
        <p className="rh-chart-none">
          この記録には角度データがありません (角度の保存に対応する前の記録です)
        </p>
      </section>
    );
  }

  const count = frames.length;
  const height = width > 0 && width < 420 ? 200 : 240;
  const padTop = 12;
  const padRight = 12;
  const padBottom = 26;
  const padLeft = 40;
  const plotW = Math.max(1, width - padLeft - padRight);
  const plotH = Math.max(1, height - padTop - padBottom);
  const stepX = count > 1 ? plotW / (count - 1) : 0;

  const xAt = (i: number) => padLeft + i * stepX;
  const yAt = (v: number) => padTop + plotH * (1 - (v - scale.lo) / (scale.hi - scale.lo));

  // 目盛りが詰まる幅では P1 / P4 / P7 / P10 だけに間引く
  const labelEvery = stepX >= 30 ? 1 : 3;

  /** 欠落フレームで線を切る (点が 2 つ以上そろった区間だけ polyline にする) */
  const buildSegments = (values: (number | null)[]): string[] => {
    const segments: string[] = [];
    let run: string[] = [];
    values.forEach((v, i) => {
      if (v === null) {
        if (run.length >= 2) segments.push(run.join(' '));
        run = [];
        return;
      }
      run.push(`${q(xAt(i))},${q(yAt(v))}`);
    });
    if (run.length >= 2) segments.push(run.join(' '));
    return segments;
  };

  /** クリック位置から最も近い P 点を選ぶ */
  const handlePlotClick = (e: ReactMouseEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = stepX > 0 ? (e.clientX - rect.left - padLeft) / stepX : 0;
    const i = Math.max(0, Math.min(count - 1, Math.round(ratio)));
    setTipIndex((prev) => (prev === i ? null : i));
    onPickFrame(i);
  };

  const tipRows =
    tipIndex === null
      ? []
      : series
          .map((s) => ({ key: s.key, value: s.values[tipIndex] }))
          .filter((r): r is { key: AngleKey; value: number } => r.value !== null);

  return (
    <section className="rh-chart">
      <div className="rh-chart-head">
        <h3 className="rh-section-title">関節角度 (P1〜P10)</h3>
        <button
          type="button"
          className="rh-chart-toggle"
          aria-pressed={showTable}
          onClick={() => setShowTable((v) => !v)}
        >
          {showTable ? '表を隠す' : '数値表'}
        </button>
      </div>

      <div className="rh-chart-plot" ref={wrapRef}>
        {width > 0 && (
          <svg
            className="rh-chart-svg"
            width={width}
            height={height}
            role="img"
            aria-label={`P1 から P${count} までの関節角度の推移。系列: ${series
              .map((s) => ANGLE_LABELS[s.key])
              .join('、')}`}
          >
            {/* --- 目盛り線 (ヘアライン・実線・控えめ) --- */}
            {scale.ticks.map((t) => (
              <g key={t}>
                <line
                  className="rh-chart-grid"
                  x1={padLeft}
                  y1={q(yAt(t))}
                  x2={padLeft + plotW}
                  y2={q(yAt(t))}
                />
                <text className="rh-chart-tick" x={padLeft - 6} y={q(yAt(t)) + 3} textAnchor="end">
                  {t}
                </text>
              </g>
            ))}

            {/* --- X 軸ラベル (P 点) --- */}
            {frames.map((frame, i) =>
              i % labelEvery === 0 || i === count - 1 ? (
                <text
                  key={frame.id}
                  className="rh-chart-tick"
                  x={q(xAt(i))}
                  y={height - 8}
                  textAnchor="middle"
                >
                  {P_POINT_INFO[frame.id].short}
                </text>
              ) : null,
            )}

            {/* --- 選択中の P 点のクロスヘア --- */}
            {tipIndex !== null && (
              <line
                className="rh-chart-crosshair"
                x1={q(xAt(tipIndex))}
                y1={padTop}
                x2={q(xAt(tipIndex))}
                y2={padTop + plotH}
              />
            )}

            {/* --- 折れ線 (2px / 欠落区間は繋がない) --- */}
            {series.map((s) =>
              buildSegments(s.values).map((points, si) => (
                <polyline
                  key={`${s.key}-${si}`}
                  className="rh-chart-line"
                  data-series={s.key}
                  points={points}
                  fill="none"
                  stroke={SERIES_COLOR[s.key]}
                />
              )),
            )}

            {/* --- データ点 (2px のサーフェスリング付き / 形状で系列を二重符号化) --- */}
            {series.map((s) => (
              <g key={`m-${s.key}`} data-series-markers={s.key}>
                {s.values.map((v, i) =>
                  v === null ? null : (
                    <path
                      key={`${s.key}-${i}`}
                      className="rh-chart-marker"
                      d={markerPath(SERIES_SHAPE[s.key], xAt(i), yAt(v), 4.5)}
                      fill={SERIES_COLOR[s.key]}
                      stroke={CHART_SURFACE}
                    />
                  ),
                )}
              </g>
            ))}

            {/* --- タップ判定用の透明レイヤー (最前面) --- */}
            <rect
              className="rh-chart-hit"
              x={0}
              y={0}
              width={width}
              height={height}
              fill="transparent"
              onClick={handlePlotClick}
            />
          </svg>
        )}

        {/* --- ツールチップ (タップで表示 / 同じ点をもう一度タップで消える) --- */}
        {tipIndex !== null && width > 0 && (
          <div
            className="rh-chart-tip"
            style={{
              left: `${xAt(tipIndex)}px`,
              transform:
                xAt(tipIndex) > width * 0.6 ? 'translate(-100%, 0)' : 'translate(0, 0)',
            }}
          >
            <div className="rh-chart-tip-head">
              {P_POINT_INFO[frames[tipIndex].id].label}
              <span className="rh-chart-tip-time">
                {frames[tipIndex].timeSec.toFixed(2)}s
              </span>
            </div>
            {tipRows.map((row) => (
              <div className="rh-chart-tip-row" key={row.key}>
                <span
                  className="rh-chart-tip-dot"
                  style={{ background: SERIES_COLOR[row.key] }}
                  aria-hidden="true"
                />
                <span className="rh-chart-tip-name">{ANGLE_LABELS[row.key]}</span>
                <span className="rh-chart-tip-value">{row.value.toFixed(1)}°</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* --- 凡例 (2 系列以上では必須。色 + 形状 + 名前で識別) --- */}
      <ul className="rh-chart-legend">
        {series.map((s) => (
          <li className="rh-chart-legend-item" key={s.key}>
            <svg className="rh-chart-legend-key" width={22} height={12} aria-hidden="true">
              <line
                x1={1}
                y1={6}
                x2={21}
                y2={6}
                stroke={SERIES_COLOR[s.key]}
                strokeWidth={2}
                strokeLinecap="round"
              />
              <path
                d={markerPath(SERIES_SHAPE[s.key], 11, 6, 4)}
                fill={SERIES_COLOR[s.key]}
                stroke={CHART_SURFACE}
                strokeWidth={2}
              />
            </svg>
            <span className="rh-chart-legend-name">{ANGLE_LABELS[s.key]}</span>
          </li>
        ))}
      </ul>

      <p className="rh-chart-hint">グラフをタップすると、その P 点の数値を表示します</p>

      {/* --- 数値表 (ツールチップに頼らず値を読める代替経路) --- */}
      {showTable && (
        <div className="rh-chart-table-wrap">
          <table className="rh-chart-table">
            <thead>
              <tr>
                <th scope="col">P 点</th>
                {series.map((s) => (
                  <th scope="col" key={s.key}>
                    {ANGLE_LABELS[s.key]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {frames.map((frame, i) => (
                <tr
                  key={frame.id}
                  className={i === activeFrameIndex ? 'rh-chart-table-row--active' : undefined}
                >
                  <th scope="row">{P_POINT_INFO[frame.id].short}</th>
                  {series.map((s) => (
                    <td key={s.key}>
                      {s.values[i] === null ? '—' : `${s.values[i]?.toFixed(1)}°`}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* =========================================================
   詳細ビュー
   ========================================================= */

interface RecordDetailProps {
  record: SwingRecord;
  onBack: () => void;
  onDelete: (record: SwingRecord) => void;
  onNoteBlur: (record: SwingRecord, note: string) => void;
}

function RecordDetail({ record, onBack, onDelete, onNoteBlur }: RecordDetailProps): JSX.Element {
  const frames = useMemo(() => orderFrames(record.frames), [record.frames]);
  const [photoIndex, setPhotoIndex] = useState(0);
  const [zoomUrl, setZoomUrl] = useState<string | null>(null);

  // 別の記録を開いたら 1 枚目に戻す
  useEffect(() => {
    setPhotoIndex(0);
  }, [record.id]);

  // 拡大中は Esc キーで閉じられるようにする
  useEffect(() => {
    if (zoomUrl === null) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoomUrl(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [zoomUrl]);

  const safeIndex = Math.max(0, Math.min(frames.length - 1, photoIndex));

  return (
    <>
      <div className="rh-header">
        <button type="button" className="rh-back-btn" onClick={onBack}>
          ← 一覧に戻る
        </button>
        <span className="rh-detail-date">{formatDateTime(record.createdAt)}</span>
        <button
          type="button"
          className="rh-delete-btn rh-delete-btn--detail"
          title="この記録を削除"
          aria-label="この記録を削除"
          onClick={() => onDelete(record)}
        >
          ✕
        </button>
      </div>

      <PhotoPager
        frames={frames}
        index={safeIndex}
        onIndexChange={setPhotoIndex}
        onZoom={setZoomUrl}
      />

      <AngleChart
        frames={frames}
        activeFrameIndex={safeIndex}
        onPickFrame={setPhotoIndex}
      />

      <ClubSpecPanel record={record} />

      {/* メモ (フォーカスを外したタイミングで保存) */}
      <div className="rh-note">
        <label className="rh-note-label" htmlFor="rh-note-input">
          メモ
        </label>
        <textarea
          id="rh-note-input"
          key={record.id}
          className="rh-note-input"
          rows={3}
          placeholder="気づいたこと、調子、天候など"
          defaultValue={record.note ?? ''}
          onBlur={(e) => onNoteBlur(record, e.currentTarget.value)}
        />
      </div>

      {/* 画像拡大オーバーレイ (どこをタップしても閉じる) */}
      {zoomUrl !== null && (
        <div className="rh-zoom-overlay" role="presentation" onClick={() => setZoomUrl(null)}>
          <img className="rh-zoom-img" src={zoomUrl} alt="拡大表示" draggable={false} />
          <span className="rh-zoom-hint">タップで閉じる</span>
        </div>
      )}
    </>
  );
}

/* =========================================================
   ルート (一覧 ⇄ 詳細)
   ========================================================= */

/**
 * スイング記録 (履歴) ビュー
 *
 * 「📋 記録」タブとして表示される読み取り専用コンポーネント。
 * localStorage に保存済みの骨格焼き込み静止画セットを一覧 ⇄ 詳細の 2 階層で閲覧する。
 * 動画の再解析は行わないため props は不要 (自己完結)。
 */
export default function RecordHistory(): JSX.Element {
  // マウント時に 1 度だけ localStorage から読み込む
  const [records, setRecords] = useState<SwingRecord[]>(() => listRecords());
  // 詳細ビューで開いている記録の id (null なら一覧)
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = records.find((r) => r.id === selectedId) ?? null;

  // 削除などで選択中の記録が消えたら一覧へ戻す
  useEffect(() => {
    if (selectedId !== null && selected === null) setSelectedId(null);
  }, [selectedId, selected]);

  /** 削除 (確認ダイアログ → ストア削除 → 一覧から除去) */
  const handleDelete = useCallback((record: SwingRecord) => {
    const label = `${formatDateTime(record.createdAt)} の記録`;
    if (!window.confirm(`${label}を削除しますか?\nこの操作は取り消せません。`)) return;

    deleteRecord(record.id);
    setRecords((prev) => prev.filter((r) => r.id !== record.id));
  }, []);

  /** メモ保存 (textarea の onBlur)。変更が無ければ書き込まない */
  const handleNoteBlur = useCallback((record: SwingRecord, note: string) => {
    if ((record.note ?? '') === note) return;

    updateRecordNote(record.id, note);
    setRecords((prev) => prev.map((r) => (r.id === record.id ? { ...r, note } : r)));
  }, []);

  const handleBack = useCallback(() => setSelectedId(null), []);

  if (selected !== null) {
    return (
      <div className="rh-root">
        <RecordDetail
          key={selected.id}
          record={selected}
          onBack={handleBack}
          onDelete={handleDelete}
          onNoteBlur={handleNoteBlur}
        />
      </div>
    );
  }

  return (
    <div className="rh-root">
      <div className="rh-header">
        <span className="rh-title">📋 スイング記録</span>
        <span className="rh-count">{records.length} 件</span>
      </div>

      {records.length === 0 ? (
        <div className="rh-empty">
          <span className="rh-empty-icon">🗂️</span>
          <span className="rh-empty-text">まだ記録がありません</span>
          <span className="rh-empty-hint">
            解析タブで P システム分解写真を切り出したあと、記録として保存できます
          </span>
        </div>
      ) : (
        <ul className="rh-list">
          {records.map((record) => {
            const thumbs = THUMB_IDS.map((id) =>
              record.frames.find((f) => f.id === id),
            ).filter((f): f is RecordFrame => f !== undefined);
            // club スナップショットがあればそちらを優先 (旧データは clubName / clubHead)
            const snapName = record.club?.name.trim() ?? '';
            const snapHead = record.club?.head.trim() ?? '';
            const clubName = snapName !== '' ? snapName : record.clubName.trim();
            const clubHead = snapHead !== '' ? snapHead : record.clubHead.trim();

            return (
              <li className="rh-card" key={record.id}>
                {/* カード本体をタップで詳細へ (削除ボタンとの入れ子を避けるため兄弟要素) */}
                <button
                  type="button"
                  className="rh-card-main"
                  onClick={() => setSelectedId(record.id)}
                >
                  <div className="rh-card-meta">
                    <span className="rh-card-date">{formatDateTime(record.createdAt)}</span>
                    <span className="rh-card-club">
                      {clubName !== '' ? clubName : 'クラブ未選択'}
                    </span>
                    {clubHead !== '' && <span className="rh-card-head">{clubHead}</span>}
                    {recordHasAngles(record) && (
                      <span className="rh-card-badge" title="関節角度グラフあり">
                        📈 角度
                      </span>
                    )}
                  </div>

                  <div className="rh-card-thumbs">
                    {thumbs.map((frame) => (
                      <span className="rh-card-thumb" key={frame.id}>
                        <img
                          className="rh-card-thumb-img"
                          src={frame.imageUrl}
                          alt={P_POINT_INFO[frame.id].label}
                          draggable={false}
                        />
                        <span className="rh-card-thumb-tag">
                          {P_POINT_INFO[frame.id].short}
                        </span>
                      </span>
                    ))}
                  </div>

                  {record.note !== undefined && record.note !== '' && (
                    <span className="rh-card-note">{record.note}</span>
                  )}
                </button>

                <button
                  type="button"
                  className="rh-delete-btn"
                  title="この記録を削除"
                  aria-label="この記録を削除"
                  onClick={() => handleDelete(record)}
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
