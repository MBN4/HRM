'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarOff, Check, Moon, Plane, StretchHorizontal } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import type { GridShift, RosterGrid as RosterGridData, RosterStatus, ScheduleDayKind } from '../../lib/api/scheduling';
import { parseYmd, ymdInTimeZone } from '../../lib/attendance-status';
import { isOvernight, resolveDay, tint, weekdayName } from '../../lib/scheduling';

export interface CellView {
  r: number;
  c: number;
  employeeId: string;
  date: string;
  kind: ScheduleDayKind;
  via: 'ROSTER' | 'STANDING' | null;
  status: RosterStatus | null;
  shift: GridShift | null;
  /** Standing hours' start time for a plain-default-hours day. */
  defaultStart: string | null;
  editable: boolean;
  fromRange: boolean;
}

const cellKey = (employeeId: string, date: string) => `${employeeId}|${date}`;

/** Resolves every (employee × day) of the grid response into what its cell shows — one pass, in memory. */
export function buildCellViews(grid: RosterGridData, now: Date = new Date()): CellView[][] {
  const shiftOf = new Map(grid.shifts.map((s) => [s.id, s]));
  const cells = new Map(grid.cells.map((c) => [cellKey(c.employeeId, c.date), c]));
  const leave = new Set(grid.leave.map((l) => cellKey(l.employeeId, l.date)));
  const weekdayOf = grid.days.map(weekdayName);
  return grid.employees.map((e, r) => {
    const branch = grid.branches[e.branchId];
    // Only HR/admin (`canDefineShifts` = tenant-wide) may touch a past day; "past" is in the EMPLOYEE'S branch zone.
    const today = ymdInTimeZone(now, branch?.timezone ?? 'UTC');
    return grid.days.map((date, c) => {
      const cell = cells.get(cellKey(e.id, date)) ?? null;
      const d = resolveDay({
        cell: cell ? { dayOff: cell.dayOff, shiftId: cell.shiftId } : null,
        standingShiftId: e.standing.shiftId,
        isWeekend: !!branch?.weekendDays.includes(weekdayOf[c]),
        isHoliday: !!branch?.holidays.includes(date),
        onLeave: leave.has(cellKey(e.id, date)),
      });
      return {
        r,
        c,
        employeeId: e.id,
        date,
        kind: d.kind,
        via: d.via,
        status: cell?.status ?? null,
        shift: d.shiftId ? (shiftOf.get(d.shiftId) ?? null) : null,
        defaultStart: e.standing.startTime,
        editable: grid.canDefineShifts || date >= today,
        fromRange: cell?.fromRange ?? false,
      };
    });
  });
}

const HATCH =
  'repeating-linear-gradient(135deg, rgb(var(--c-ink-400) / 0.28) 0, rgb(var(--c-ink-400) / 0.28) 2px, transparent 2px, transparent 7px)';

/** One roster cell. Memoised on primitives so a 1000-row grid only re-renders what changed. */
const Cell = memo(function Cell({
  v,
  selected,
  tabbable,
  compact,
  label,
}: {
  v: CellView;
  selected: boolean;
  tabbable: boolean;
  compact: boolean;
  label: string;
}) {
  const { t } = useI18n();
  const shift = v.shift;
  const draft = v.status === 'DRAFT';
  const standing = v.kind === 'SHIFT' && v.via === 'STANDING';
  const color = shift?.color ?? null;
  let body: React.ReactNode;
  const base = 'flex h-full min-h-[3.25rem] w-full flex-col justify-center gap-0.5 rounded-md px-1.5 py-1 text-start text-[0.7rem] leading-tight';
  let style: React.CSSProperties | undefined;
  let cls = base;

  if (v.kind === 'SHIFT' && shift) {
    style = {
      backgroundColor: tint(color, standing ? '14' : '2e'),
      borderInlineStart: `3px ${standing ? 'dotted' : 'solid'} ${color ?? '#2e9e7e'}`,
      ...(draft ? { backgroundImage: HATCH } : {}),
    };
    cls = `${base} text-ink-900 ${draft ? 'border border-dashed border-ink-400' : ''} ${standing ? 'text-ink-600' : ''}`;
    body = (
      <>
        <span className="flex items-center gap-1 font-semibold">
          <span className="truncate">{compact ? shift.name.slice(0, 4) : shift.name}</span>
          {isOvernight(shift.startTime, shift.endTime) && <Moon className="h-3 w-3 shrink-0" aria-hidden />}
        </span>
        {!compact && (
          <span className="tabular-nums text-ink-600">
            <bdi dir="ltr">
              {shift.startTime}–{shift.endTime}
            </bdi>
            {isOvernight(shift.startTime, shift.endTime) && (
              <bdi dir="ltr" aria-hidden>
                {' '}
                +1
              </bdi>
            )}
          </span>
        )}
        {!compact && draft && <span className="font-semibold uppercase tracking-wide text-ink-700">{t('scheduling.status.DRAFT')}</span>}
        {!compact && standing && <span className="italic text-ink-500">{t('scheduling.via.STANDING')}</span>}
      </>
    );
  } else if (v.kind === 'DAY_OFF') {
    cls = `${base} border border-dashed border-ink-300 bg-sand-100 text-ink-700 ${draft ? '' : ''}`;
    style = draft ? { backgroundImage: HATCH } : undefined;
    body = (
      <>
        <span className="flex items-center gap-1 font-semibold">
          <CalendarOff className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">{compact ? t('scheduling.cell.offShort') : t('scheduling.cell.dayOff')}</span>
        </span>
        {!compact && draft && <span className="font-semibold uppercase tracking-wide">{t('scheduling.status.DRAFT')}</span>}
      </>
    );
  } else if (v.kind === 'WEEKEND' || v.kind === 'HOLIDAY') {
    cls = `${base} bg-sand-100 text-ink-400`;
    body = <span className="truncate">{compact ? '·' : t(`scheduling.cell.${v.kind}`)}</span>;
  } else if (v.kind === 'LEAVE') {
    cls = `${base} bg-sky-50 text-sky-700`;
    body = (
      <span className="flex items-center gap-1 font-semibold">
        <Plane className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate">{compact ? t('scheduling.cell.leaveShort') : t('scheduling.cell.LEAVE')}</span>
      </span>
    );
  } else {
    cls = `${base} text-ink-400`;
    body = (
      <>
        <span className="tabular-nums">{v.defaultStart ? <bdi dir="ltr">{v.defaultStart}</bdi> : '—'}</span>
        {!compact && <span className="italic">{t('scheduling.cell.default')}</span>}
      </>
    );
  }

  return (
    <button
      type="button"
      data-cell
      data-r={v.r}
      data-c={v.c}
      data-testid={`roster-cell-${v.employeeId}-${v.date}`}
      data-kind={v.kind}
      data-via={v.via ?? ''}
      data-status={v.status ?? ''}
      data-shift={shift?.id ?? ''}
      data-editable={v.editable ? 'true' : 'false'}
      aria-label={label}
      aria-disabled={!v.editable || undefined}
      aria-pressed={selected}
      tabIndex={tabbable ? 0 : -1}
      className={`relative ${cls} transition-shadow ${v.editable ? 'cursor-pointer hover:shadow-pop' : 'cursor-not-allowed opacity-70'} ${
        selected ? 'ring-2 ring-accent-500 ring-offset-1 ring-offset-surface' : ''
      }`}
      style={style}
    >
      {body}
      {selected && <Check className="absolute end-1 top-1 h-3 w-3 text-accent-500" aria-hidden />}
    </button>
  );
});

export interface RosterGridProps {
  grid: RosterGridData;
  selected: Set<string>;
  onSelect: (keys: Set<string>, opts: { open: boolean; anchor: CellView | null }) => void;
  busy?: boolean;
  compact: boolean;
}

/** Rows of consecutive-index rectangle between two cells (editable ones only). */
function rect(views: CellView[][], a: CellView, b: CellView): Set<string> {
  const out = new Set<string>();
  for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r += 1) {
    for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c += 1) {
      const v = views[r]?.[c];
      if (v?.editable) out.add(cellKey(v.employeeId, v.date));
    }
  }
  return out;
}

/**
 * The roster calendar: employees as rows × days as columns, an ARIA grid of real buttons. Everything positional is
 * logical (grid column order, `sticky start-0`, `border-e`, `ps-`/`ms-`) so `dir="rtl"` mirrors it with no
 * direction-specific code except arrow-key navigation, which flips explicitly. Selection: click = open the editor for
 * that cell; shift-click = range; ctrl/cmd-click = toggle; click-drag = rectangle; a day header = the whole column;
 * a row's "select row" button = the whole row.
 */
export function RosterGrid({ grid, selected, onSelect, busy, compact }: RosterGridProps) {
  const { t, locale, dir } = useI18n();
  const views = useMemo(() => buildCellViews(grid), [grid]);
  const [focus, setFocus] = useState({ r: 0, c: 0 });
  const anchorRef = useRef<CellView | null>(null);
  const dragRef = useRef<{ start: CellView; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setFocus({ r: 0, c: 0 });
    anchorRef.current = null;
  }, [grid.from, grid.to]);

  const viewAt = useCallback(
    (el: Element | null): CellView | null => {
      const b = el?.closest<HTMLElement>('[data-cell]');
      if (!b) return null;
      return views[Number(b.dataset.r)]?.[Number(b.dataset.c)] ?? null;
    },
    [views],
  );

  useEffect(() => {
    function up() {
      if (dragRef.current?.moved) {
        suppressClick.current = true;
        setTimeout(() => (suppressClick.current = false), 0);
      }
      dragRef.current = null;
    }
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  function describe(v: CellView): string {
    const e = grid.employees[v.r];
    const day = new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: 'UTC' }).format(parseYmd(v.date));
    let what: string;
    if (v.kind === 'SHIFT' && v.shift) {
      const times = `${v.shift.name} ${v.shift.startTime}–${v.shift.endTime}${isOvernight(v.shift.startTime, v.shift.endTime) ? ` (${t('scheduling.overnight')})` : ''}`;
      what = v.via === 'STANDING' ? `${t('scheduling.via.STANDING')}: ${times}` : `${times}${v.status === 'DRAFT' ? `, ${t('scheduling.status.DRAFT')}` : `, ${t('scheduling.status.PUBLISHED')}`}`;
    } else if (v.kind === 'DAY_OFF') what = `${t('scheduling.cell.dayOff')}${v.status === 'DRAFT' ? `, ${t('scheduling.status.DRAFT')}` : ''}`;
    else if (v.kind === 'DEFAULT_HOURS') what = `${t('scheduling.cell.default')}${v.defaultStart ? ` ${v.defaultStart}` : ''}`;
    else what = t(`scheduling.cell.${v.kind}`);
    return `${e.name}, ${day}: ${what}${v.editable ? '' : `, ${t('scheduling.cell.readOnly')}`}`;
  }

  function onMouseDown(ev: React.MouseEvent) {
    if (ev.button !== 0 || ev.shiftKey || ev.ctrlKey || ev.metaKey) return;
    const v = viewAt(ev.target as Element);
    if (v?.editable) dragRef.current = { start: v, moved: false };
  }
  function onMouseOver(ev: React.MouseEvent) {
    const d = dragRef.current;
    if (!d) return;
    const v = viewAt(ev.target as Element);
    if (!v || (v.r === d.start.r && v.c === d.start.c && !d.moved)) return;
    d.moved = true;
    anchorRef.current = d.start;
    onSelect(rect(views, d.start, v), { open: false, anchor: d.start });
  }
  function onClick(ev: React.MouseEvent) {
    if (suppressClick.current) return;
    const v = viewAt(ev.target as Element);
    if (!v || !v.editable) return;
    setFocus({ r: v.r, c: v.c });
    const key = cellKey(v.employeeId, v.date);
    if (ev.shiftKey && anchorRef.current) {
      onSelect(rect(views, anchorRef.current, v), { open: false, anchor: anchorRef.current });
    } else if (ev.ctrlKey || ev.metaKey) {
      const next = new Set(selected);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      anchorRef.current = v;
      onSelect(next, { open: false, anchor: v });
    } else {
      anchorRef.current = v;
      onSelect(new Set([key]), { open: true, anchor: v });
    }
  }
  function onKeyDown(ev: React.KeyboardEvent) {
    const v = viewAt(ev.target as Element);
    if (!v) return;
    const sign = dir === 'rtl' ? -1 : 1;
    let { r, c } = v;
    if (ev.key === 'ArrowRight') c += sign;
    else if (ev.key === 'ArrowLeft') c -= sign;
    else if (ev.key === 'ArrowDown') r += 1;
    else if (ev.key === 'ArrowUp') r -= 1;
    else if (ev.key === 'Home') c = 0;
    else if (ev.key === 'End') c = grid.days.length - 1;
    else if (ev.key === 'Escape' && selected.size > 0) {
      onSelect(new Set(), { open: false, anchor: null });
      return;
    } else return;
    ev.preventDefault();
    r = Math.max(0, Math.min(views.length - 1, r));
    c = Math.max(0, Math.min(grid.days.length - 1, c));
    setFocus({ r, c });
    rootRef.current?.querySelector<HTMLElement>(`[data-r="${r}"][data-c="${c}"]`)?.focus();
  }

  const colMin = compact ? '4.25rem' : '7.25rem';
  const template = `minmax(11rem, 14rem) repeat(${grid.days.length}, minmax(${colMin}, 1fr))`;
  const today = ymdInTimeZone(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone);

  function selectRow(r: number) {
    onSelect(new Set(views[r].filter((v) => v.editable).map((v) => cellKey(v.employeeId, v.date))), { open: false, anchor: views[r][0] ?? null });
  }
  function selectColumn(c: number) {
    onSelect(new Set(views.map((row) => row[c]).filter((v) => v?.editable).map((v) => cellKey(v.employeeId, v.date))), { open: false, anchor: views[0]?.[c] ?? null });
  }

  return (
    <div
      ref={rootRef}
      className={`max-h-[70vh] overflow-auto rounded-xl border border-ink-100 bg-surface ${busy ? 'opacity-60' : ''} transition-opacity`}
      data-testid="roster-grid"
      aria-busy={busy}
    >
      <div
        role="grid"
        aria-label={t('scheduling.grid.label')}
        aria-multiselectable
        className="select-none"
        style={{ minWidth: `calc(11rem + ${grid.days.length} * ${colMin})` }}
        onMouseDown={onMouseDown}
        onMouseOver={onMouseOver}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        <div role="row" className="sticky top-0 z-20 grid border-b border-ink-100 bg-surface-raised" style={{ gridTemplateColumns: template }}>
          <div role="columnheader" className="sticky start-0 top-0 z-30 border-e border-ink-100 bg-surface-raised px-3 py-2 text-xs font-medium text-ink-500">
            {t('scheduling.grid.employee')}
          </div>
          {grid.days.map((d, c) => {
            const isToday = d === today;
            return (
              <div key={d} role="columnheader" className={`px-1 py-1 text-center ${isToday ? 'bg-brand-50' : ''}`}>
                <button
                  type="button"
                  data-testid={`roster-col-${d}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    selectColumn(c);
                  }}
                  aria-label={t('scheduling.grid.selectColumn', { date: new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: 'UTC' }).format(parseYmd(d)) })}
                  title={t('scheduling.grid.selectColumnHint')}
                  className={`w-full rounded-md px-1 py-1 text-[0.7rem] font-semibold leading-tight hover:bg-sand-200 ${isToday ? 'text-brand-700' : 'text-ink-600'}`}
                >
                  <span className="block">{new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(parseYmd(d))}</span>
                  <span className="block text-sm tabular-nums">{Number(d.slice(8))}</span>
                </button>
              </div>
            );
          })}
        </div>

        {grid.employees.map((e, r) => (
          <div key={e.id} role="row" className="grid border-b border-ink-100 last:border-0" style={{ gridTemplateColumns: template }} data-testid={`roster-row-${e.code}`}>
            <div role="rowheader" className="sticky start-0 z-10 flex items-center justify-between gap-2 border-e border-ink-100 bg-surface px-3 py-1.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink-900">{e.name}</p>
                <p className="truncate text-[0.7rem] text-ink-400">
                  {e.code}
                  {e.departmentName ? ` · ${e.departmentName}` : ''}
                </p>
              </div>
              <button
                type="button"
                data-testid={`roster-fill-row-${e.code}`}
                onClick={(ev) => {
                  ev.stopPropagation();
                  selectRow(r);
                }}
                aria-label={t('scheduling.grid.selectRow', { name: e.name })}
                title={t('scheduling.grid.selectRowHint')}
                className="shrink-0 rounded-md p-1 text-ink-400 hover:bg-sand-200 hover:text-ink-700"
              >
                <StretchHorizontal className="h-4 w-4" aria-hidden />
              </button>
            </div>
            {views[r].map((v) => (
              <div key={v.date} role="gridcell" aria-selected={selected.has(cellKey(v.employeeId, v.date))} className={`relative p-0.5 ${v.date === today ? 'bg-brand-50/40' : ''}`}>
                <Cell v={v} selected={selected.has(cellKey(v.employeeId, v.date))} tabbable={focus.r === r && focus.c === v.c} compact={compact} label={describe(v)} />
              </div>
            ))}
          </div>
        ))}
        {grid.employees.length === 0 && <p className="px-4 py-8 text-center text-sm text-ink-500">{t('scheduling.grid.empty')}</p>}
      </div>
      <span className="sr-only" aria-live="polite">
        {selected.size > 0 ? t('scheduling.selection.count', { count: selected.size }) : ''}
      </span>
    </div>
  );
}

export { cellKey };
