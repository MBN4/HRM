'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CopyPlus, Send, X } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { ApiError } from '../../lib/api/client';
import { copyRoster, getRosterGrid, publishRoster, type RosterGrid as RosterGridData } from '../../lib/api/scheduling';
import { addDaysYmd } from '../../lib/attendance-status';
import { windowFor } from '../../lib/scheduling';
import { Alert } from '../ui/Alert';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { PageSpinner } from '../ui/Spinner';
import { AssignModal } from './AssignModal';
import { RosterGrid } from './RosterGrid';
import { useScheduling } from './SchedulingContext';
import { ShiftLegend } from './ShiftLegend';
import { WindowToolbar } from './WindowToolbar';

/** The `/scheduling` roster calendar: toolbar (window, team, copy last week, publish), the grid, the selection bar and the assign modal. */
export function RosterView() {
  const { t } = useI18n();
  const { anchor, mode, departmentId } = useScheduling();
  const { from, to } = windowFor(anchor, mode);

  const [grid, setGrid] = useState<RosterGridData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assigning, setAssigning] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [copying, setCopying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getRosterGrid(from, to, departmentId)
      .then((g) => {
        if (cancelled) return;
        setGrid(g);
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : t('error.generic'));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, departmentId, version]);

  // The selection belongs to one window/filter — drop it when either changes.
  useEffect(() => {
    setSelected(new Set());
    setAssigning(false);
  }, [from, to, departmentId]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const drafts = useMemo(() => (grid?.cells ?? []).filter((c) => c.status === 'DRAFT'), [grid]);
  const draftPeople = useMemo(() => new Set(drafts.map((d) => d.employeeId)).size, [drafts]);

  const selectedCells = useMemo(
    () =>
      [...selected].map((k) => {
        const [employeeId, date] = k.split('|');
        return { employeeId, date };
      }),
    [selected],
  );
  const publishedInSelection = useMemo(() => {
    if (!grid) return 0;
    const published = new Set(grid.cells.filter((c) => c.status === 'PUBLISHED').map((c) => `${c.employeeId}|${c.date}`));
    return selectedCells.filter((c) => published.has(`${c.employeeId}|${c.date}`)).length;
  }, [grid, selectedCells]);

  async function doCopy() {
    setCopying(true);
    setError(null);
    setNotice(null);
    try {
      const res = await copyRoster({ sourceFrom: addDaysYmd(from, -7), sourceTo: addDaysYmd(from, -1), targetFrom: from, departmentId: departmentId || undefined });
      setNotice(res.copied === 0 ? t('scheduling.copy.none') : t('scheduling.copy.done', { copied: res.copied, created: res.created, updated: res.updated }));
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setCopying(false);
    }
  }

  const compact = mode === 'month';

  return (
    <div className="space-y-4">
      <WindowToolbar>
        <div className="ms-auto flex flex-wrap items-center gap-2">
          <Badge tone={drafts.length > 0 ? 'warning' : 'neutral'}>
            <span data-testid="draft-count" data-count={drafts.length}>
              {t('scheduling.drafts.count', { count: drafts.length })}
            </span>
          </Badge>
          <Button variant="secondary" onClick={doCopy} loading={copying} disabled={mode !== 'week' || !grid} title={mode !== 'week' ? t('scheduling.copy.weekOnly') : undefined} data-testid="copy-last-week">
            <CopyPlus className="h-4 w-4" aria-hidden />
            {t('scheduling.copy.button')}
          </Button>
          <Button onClick={() => setPublishing(true)} disabled={drafts.length === 0} data-testid="publish-button">
            <Send className="h-4 w-4 rtl:-scale-x-100" aria-hidden />
            {t('scheduling.publish.button')}
          </Button>
        </div>
      </WindowToolbar>

      {error && <Alert tone="error" data-testid="roster-error">{error}</Alert>}
      {notice && <Alert tone="success" data-testid="roster-notice">{notice}</Alert>}
      {grid && !grid.canDefineShifts && <Alert tone="info">{t('scheduling.manager.pastNote')}</Alert>}

      {selected.size > 0 && (
        <div role="region" aria-label={t('scheduling.selection.bar')} className="flex flex-wrap items-center gap-3 rounded-xl border border-accent-500 bg-brand-50 px-4 py-2.5 text-sm" data-testid="selection-bar">
          <span className="font-medium text-brand-800" data-testid="selection-count">
            {t('scheduling.selection.count', { count: selected.size })}
          </span>
          <Button size="sm" onClick={() => setAssigning(true)} data-testid="selection-assign">
            {t('scheduling.selection.assign')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} data-testid="selection-clear">
            <X className="h-4 w-4" aria-hidden />
            {t('scheduling.selection.clear')}
          </Button>
          <span className="text-xs text-ink-500">{t('scheduling.selection.hint')}</span>
        </div>
      )}

      {loading && !grid ? (
        <PageSpinner />
      ) : grid ? (
        <>
          <RosterGrid
            grid={grid}
            selected={selected}
            busy={loading}
            compact={compact}
            onSelect={(keys, opts) => {
              setSelected(keys);
              setAssigning(opts.open);
            }}
          />
          <ShiftLegend shifts={grid.shifts} />
        </>
      ) : null}

      {assigning && grid && selected.size > 0 && (
        <AssignModal
          shifts={grid.shifts}
          cells={selectedCells}
          publishedCount={publishedInSelection}
          title={t('scheduling.assign.title')}
          onClose={() => {
            setAssigning(false);
            if (selected.size === 1) setSelected(new Set());
          }}
          onSaved={(n) => {
            setAssigning(false);
            setSelected(new Set());
            setError(null);
            setNotice(t('scheduling.assign.saved', { count: n }));
            reload();
          }}
        />
      )}

      {publishing && (
        <ConfirmDialog
          title={t('scheduling.publish.title')}
          body={t('scheduling.publish.body', { count: drafts.length, people: draftPeople })}
          confirmLabel={t('scheduling.publish.confirm')}
          onClose={() => setPublishing(false)}
          onConfirm={async () => {
            const res = await publishRoster({ from, to, departmentId: departmentId || undefined });
            setPublishing(false);
            setError(null);
            setNotice(t('scheduling.publish.done', { published: res.published, employees: res.employees }));
            reload();
          }}
        />
      )}
    </div>
  );
}
