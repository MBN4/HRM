'use client';

/**
 * The shared chart kit (docs/conventions/design-system.md § Charts) — ONE
 * place that decides how a Recharts chart looks in MBN: series colors come
 * from the `--c-chart-*` tokens (so light/dark/the toggle all just work, no
 * per-chart theming), tooltips/legends are plain Tailwind HTML (Recharts lets
 * `content` be a React node), and every directional choice is RTL-aware
 * (reversed X axis / right-hand Y axis under `dir="rtl"`).
 * Duplicated verbatim in apps/admin (no shared React package — same reasoning
 * as I18nProvider). Never put a raw hex/rgb color in a call site; pass a
 * series index or a token.
 */
import { ArrowDownRight, ArrowUpRight, Minus, type LucideIcon } from 'lucide-react';
import { ReactNode, useId, useMemo, useState } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useI18n } from '../../i18n/I18nProvider';

/** Series palette: the five `chart-*` tokens, then a mid green and a neutral for "other". */
export const SERIES_COLORS = [
  'rgb(var(--c-chart-1))',
  'rgb(var(--c-chart-2))',
  'rgb(var(--c-chart-3))',
  'rgb(var(--c-chart-4))',
  'rgb(var(--c-chart-5))',
  'rgb(var(--c-brand-400))',
  'rgb(var(--c-ink-400))',
];
export const seriesColor = (i: number) => SERIES_COLORS[i % SERIES_COLORS.length];

const AXIS_TICK = { fontSize: 11, fill: 'rgb(var(--c-ink-500))' } as const;
const AXIS_LINE = 'rgb(var(--c-ink-200))';
const GRID = 'rgb(var(--c-ink-100))';

export function formatCompact(value: number, locale: string): string {
  return new Intl.NumberFormat(locale.replace('_', '-'), { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}
function formatFull(value: number, locale: string): string {
  return new Intl.NumberFormat(locale.replace('_', '-'), { maximumFractionDigits: 2 }).format(value);
}

// ---------------------------------------------------------------- skeletons

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-md bg-sand-200 ${className}`} />;
}

const SKELETON_BARS = [40, 65, 50, 80, 55, 90, 70, 45, 60, 75];

export function ChartSkeleton({ height = 240 }: { height?: number }) {
  return (
    <div aria-hidden style={{ height }} className="flex items-end gap-2 px-1">
      {SKELETON_BARS.map((h, i) => (
        <div key={i} className="flex h-full flex-1 items-end">
          <div className="w-full animate-pulse rounded-t-md bg-sand-200" style={{ height: `${h}%` }} />
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ KPI card

export interface Trend {
  /** e.g. "+4.2%" — already formatted by the caller. */
  text: string;
  dir: 'up' | 'down' | 'flat';
  /** good = brand green, bad = coral, neutral = grey (a "down" can be good, e.g. attrition). */
  tone: 'good' | 'bad' | 'neutral';
  title?: string;
}

const TREND_TONE = {
  good: 'bg-brand-50 text-brand-700',
  bad: 'bg-coral-50 text-coral-600',
  neutral: 'bg-sand-100 text-ink-500',
} as const;

export function TrendPill({ trend }: { trend: Trend }) {
  const Icon = trend.dir === 'up' ? ArrowUpRight : trend.dir === 'down' ? ArrowDownRight : Minus;
  return (
    <span title={trend.title} className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold ${TREND_TONE[trend.tone]}`}>
      <Icon className="h-3 w-3 rtl:-scale-x-100" aria-hidden />
      <span dir="ltr">{trend.text}</span>
    </span>
  );
}

export function KpiCard({
  label,
  value,
  hint,
  icon: Icon,
  trend,
  spark,
  loading,
  testId,
  index = 0,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: LucideIcon;
  trend?: Trend | null;
  spark?: number[];
  loading?: boolean;
  testId?: string;
  /** Stagger the entrance animation across a row of tiles. */
  index?: number;
}) {
  return (
    <div
      style={{ animationDelay: `${index * 50}ms` }}
      className="animate-fade-up rounded-xl2 border border-ink-100 bg-surface p-5 shadow-card transition-shadow hover:shadow-soft"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="eyebrow text-ink-400">{label}</p>
        {Icon && (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
            <Icon className="h-4 w-4" aria-hidden />
          </span>
        )}
      </div>
      {loading ? (
        <Skeleton className="mt-3 h-8 w-24" />
      ) : (
        <p data-testid={testId} className="mt-2 text-3xl font-semibold tracking-tight text-ink-900">
          {value}
        </p>
      )}
      <div className="mt-2 flex min-h-[1.5rem] items-center gap-2">
        {loading ? <Skeleton className="h-5 w-16" /> : trend && <TrendPill trend={trend} />}
        {!loading && hint && <p className="truncate text-xs text-ink-400">{hint}</p>}
      </div>
      {spark && spark.length > 1 && !loading && <Sparkline values={spark} />}
    </div>
  );
}

export function Sparkline({ values }: { values: number[] }) {
  const id = useId();
  const data = useMemo(() => values.map((v, i) => ({ i, v })), [values]);
  return (
    <div aria-hidden className="mt-2 h-10 w-full" dir="ltr">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={seriesColor(0)} stopOpacity={0.35} />
              <stop offset="100%" stopColor={seriesColor(0)} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area type="monotone" dataKey="v" stroke={seriesColor(0)} strokeWidth={1.5} fill={`url(#${id})`} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ------------------------------------------------------------- chart card

export function ChartCard({
  title,
  subtitle,
  actions,
  loading,
  empty,
  emptyText,
  height = 260,
  className = '',
  children,
  testId,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  loading?: boolean;
  empty?: boolean;
  emptyText?: string;
  height?: number;
  className?: string;
  children: ReactNode;
  testId?: string;
}) {
  const { t } = useI18n();
  return (
    <section data-testid={testId} className={`animate-fade-up rounded-xl2 border border-ink-100 bg-surface shadow-card ${className}`}>
      <header className="flex items-start justify-between gap-3 border-b border-ink-100 px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight text-ink-900">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-ink-400">{subtitle}</p>}
        </div>
        {actions}
      </header>
      <div className="px-5 py-5">
        {loading ? (
          <ChartSkeleton height={height} />
        ) : empty ? (
          <div style={{ height }} className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-ink-200 text-center">
            <p className="text-sm font-medium text-ink-500">{emptyText ?? t('common.noData')}</p>
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- tooltip

interface TipPayload {
  name?: string | number;
  value?: number | string;
  color?: string;
  dataKey?: string | number;
  payload?: Record<string, unknown>;
}

export function ChartTooltip({
  active,
  payload,
  label,
  formatValue,
  labelFormatter,
}: {
  active?: boolean;
  payload?: TipPayload[];
  label?: string | number;
  formatValue?: (v: number, name: string) => string;
  labelFormatter?: (l: string | number | undefined) => string;
}) {
  const { locale } = useI18n();
  if (!active || !payload?.length) return null;
  const head = labelFormatter ? labelFormatter(label) : label !== undefined ? String(label) : (payload[0].name ?? '');
  return (
    <div className="min-w-[8rem] rounded-lg border border-ink-100 bg-surface-raised px-3 py-2 text-xs shadow-pop">
      {head !== '' && <p className="mb-1 font-semibold text-ink-900">{head}</p>}
      <ul className="space-y-0.5">
        {payload.map((p, i) => (
          <li key={`${p.dataKey ?? p.name}-${i}`} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-ink-500">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
              {p.name}
            </span>
            <span dir="ltr" className="font-semibold tabular-nums text-ink-900">
              {formatValue ? formatValue(Number(p.value), String(p.name)) : formatFull(Number(p.value), locale)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ----------------------------------------------------------------- legend

export interface SeriesDef {
  key: string;
  label: string;
  /** Index into SERIES_COLORS (defaults to the series' own position). */
  color?: number;
}

/** A click-to-toggle legend — hiding a series is the chart's "filter" interaction. */
function ToggleLegend({ series, hidden, onToggle }: { series: SeriesDef[]; hidden: Set<string>; onToggle: (key: string) => void }) {
  return (
    <ul className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
      {series.map((s, i) => {
        const off = hidden.has(s.key);
        return (
          <li key={s.key}>
            <button
              type="button"
              aria-pressed={!off}
              onClick={() => onToggle(s.key)}
              className={`flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs transition-opacity hover:bg-sand-100 ${off ? 'opacity-40' : ''}`}
            >
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: seriesColor(s.color ?? i) }} />
              <span className="text-ink-600">{s.label}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function useHidden() {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return { hidden, toggle };
}

// ------------------------------------------------------------ area / line

export function TrendAreaChart({
  data,
  xKey,
  series,
  height = 260,
  formatX,
  formatValue,
  stacked,
}: {
  data: Record<string, string | number>[];
  xKey: string;
  series: SeriesDef[];
  height?: number;
  formatX?: (v: string | number) => string;
  formatValue?: (v: number, name: string) => string;
  stacked?: boolean;
}) {
  const { dir, locale } = useI18n();
  const rtl = dir === 'rtl';
  const uid = useId().replace(/:/g, '');
  const { hidden, toggle } = useHidden();
  return (
    <div>
      <div style={{ height }} dir="ltr" className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <defs>
              {series.map((s, i) => (
                <linearGradient key={s.key} id={`${uid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={seriesColor(s.color ?? i)} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={seriesColor(s.color ?? i)} stopOpacity={0.02} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={GRID} />
            <XAxis
              dataKey={xKey}
              tick={AXIS_TICK}
              tickFormatter={formatX}
              stroke={AXIS_LINE}
              tickLine={false}
              minTickGap={24}
              reversed={rtl}
            />
            <YAxis
              tick={AXIS_TICK}
              stroke={AXIS_LINE}
              tickLine={false}
              axisLine={false}
              allowDecimals={false}
              width={44}
              tickFormatter={(v) => formatCompact(Number(v), locale)}
              orientation={rtl ? 'right' : 'left'}
            />
            <Tooltip
              cursor={{ stroke: 'rgb(var(--c-ink-300))', strokeDasharray: '3 3' }}
              content={<ChartTooltip formatValue={formatValue} labelFormatter={(l) => (formatX && l !== undefined ? formatX(l) : String(l ?? ''))} />}
            />
            {series.map((s, i) =>
              hidden.has(s.key) ? null : (
                <Area
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.label}
                  stackId={stacked ? 'a' : undefined}
                  stroke={seriesColor(s.color ?? i)}
                  strokeWidth={2}
                  fill={`url(#${uid}-${s.key})`}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: 'rgb(var(--c-surface))' }}
                  animationDuration={500}
                  isAnimationActive={!rtl}
                />
              ),
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {series.length > 1 && <ToggleLegend series={series} hidden={hidden} onToggle={toggle} />}
    </div>
  );
}

// -------------------------------------------------------------------- bars

export function BarBreakdown({
  data,
  xKey,
  series,
  height = 260,
  horizontal,
  stacked,
  formatValue,
}: {
  data: Record<string, string | number>[];
  xKey: string;
  series: SeriesDef[];
  height?: number;
  /** Horizontal bars — use for long category names (departments, leave types). */
  horizontal?: boolean;
  stacked?: boolean;
  formatValue?: (v: number, name: string) => string;
}) {
  const { dir, locale } = useI18n();
  const rtl = dir === 'rtl';
  const { hidden, toggle } = useHidden();
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const shown = series.filter((s) => !hidden.has(s.key));
  const tick = (v: unknown) => formatCompact(Number(v), locale);
  return (
    <div>
      <div style={{ height: horizontal ? Math.max(height, data.length * 44 + 24) : height }} dir="ltr" className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            layout={horizontal ? 'vertical' : 'horizontal'}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            barCategoryGap={horizontal ? '28%' : '24%'}
            onMouseMove={(s) => setActiveIdx(typeof s?.activeTooltipIndex === 'number' ? s.activeTooltipIndex : null)}
            onMouseLeave={() => setActiveIdx(null)}
          >
            <CartesianGrid strokeDasharray="3 3" vertical={!!horizontal} horizontal={!horizontal} stroke={GRID} />
            {horizontal ? (
              <>
                <XAxis type="number" tick={AXIS_TICK} stroke={AXIS_LINE} tickLine={false} axisLine={false} allowDecimals={false} tickFormatter={tick} reversed={rtl} />
                <YAxis
                  type="category"
                  dataKey={xKey}
                  tick={AXIS_TICK}
                  stroke={AXIS_LINE}
                  tickLine={false}
                  axisLine={false}
                  width={110}
                  orientation={rtl ? 'right' : 'left'}
                />
              </>
            ) : (
              <>
                <XAxis dataKey={xKey} tick={AXIS_TICK} stroke={AXIS_LINE} tickLine={false} reversed={rtl} />
                <YAxis
                  tick={AXIS_TICK}
                  stroke={AXIS_LINE}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                  width={44}
                  tickFormatter={tick}
                  orientation={rtl ? 'right' : 'left'}
                />
              </>
            )}
            <Tooltip cursor={{ fill: 'rgb(var(--c-sand-200) / 0.5)' }} content={<ChartTooltip formatValue={formatValue} />} />
            {shown.map((s) => {
              const i = series.indexOf(s);
              return (
                <Bar
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  stackId={stacked ? 's' : undefined}
                  fill={seriesColor(s.color ?? i)}
                  radius={stacked ? 0 : horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
                  animationDuration={500}
                  isAnimationActive={!rtl}
                >
                  {data.map((_, di) => (
                    <Cell key={di} fillOpacity={activeIdx === null || activeIdx === di ? 1 : 0.55} />
                  ))}
                </Bar>
              );
            })}
          </BarChart>
        </ResponsiveContainer>
      </div>
      {series.length > 1 && <ToggleLegend series={series} hidden={hidden} onToggle={toggle} />}
    </div>
  );
}

// ------------------------------------------------------------------- donut

export function DonutChart({
  data,
  height = 220,
  centerLabel,
  formatValue,
}: {
  data: { name: string; value: number }[];
  height?: number;
  centerLabel?: string;
  formatValue?: (v: number) => string;
}) {
  const { locale } = useI18n();
  const [hover, setHover] = useState<number | null>(null);
  const rows = data.filter((d) => d.value > 0);
  const total = rows.reduce((s, r) => s + r.value, 0);
  const fmt = formatValue ?? ((v: number) => formatFull(v, locale));
  const pct = (v: number) => new Intl.NumberFormat(locale.replace('_', '-'), { style: 'percent', maximumFractionDigits: 0 }).format(total ? v / total : 0);
  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center">
      <div style={{ height, width: height }} dir="ltr" className="relative shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={rows}
              dataKey="value"
              nameKey="name"
              innerRadius="62%"
              outerRadius="92%"
              paddingAngle={rows.length > 1 ? 2 : 0}
              stroke="none"
              animationDuration={600}
              onMouseEnter={(_, i) => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              {rows.map((_, i) => (
                <Cell key={i} fill={seriesColor(i)} fillOpacity={hover === null || hover === i ? 1 : 0.45} style={{ transition: 'fill-opacity 120ms', outline: 'none' }} />
              ))}
            </Pie>
            <Tooltip content={<ChartTooltip formatValue={(v) => `${fmt(v)} · ${pct(v)}`} />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold tracking-tight text-ink-900">{fmt(hover !== null ? rows[hover].value : total)}</span>
          <span className="max-w-[6rem] truncate text-xs text-ink-400">{hover !== null ? rows[hover].name : centerLabel}</span>
        </div>
      </div>
      <ul className="w-full min-w-0 flex-1 space-y-1">
        {rows.map((r, i) => (
          <li
            key={r.name}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            className={`flex items-center justify-between gap-3 rounded-md px-2 py-1 text-sm transition-colors ${hover === i ? 'bg-sand-100' : ''}`}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: seriesColor(i) }} />
              <span className="truncate text-ink-600">{r.name}</span>
            </span>
            <span className="shrink-0 tabular-nums text-ink-900">
              <span className="font-semibold">{fmt(r.value)}</span> <span className="text-xs text-ink-400">{pct(r.value)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Collapse the long tail of a categorical breakdown into one "Other" slice so a donut never exceeds the palette. */
export function topN<T extends { name: string; value: number }>(rows: T[], n: number, otherLabel: string): { name: string; value: number }[] {
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  if (sorted.length <= n) return sorted;
  const head = sorted.slice(0, n - 1);
  const rest = sorted.slice(n - 1).reduce((s, r) => s + r.value, 0);
  return [...head, { name: otherLabel, value: rest }];
}
