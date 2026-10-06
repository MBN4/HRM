'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Activity, Building2, CreditCard, ShieldCheck, TriangleAlert, Users } from 'lucide-react';
import { useAsync } from '../../../lib/useAsync';
import { getTenantUsage, getUsageOverview } from '../../../lib/api/usage';
import { listTenants } from '../../../lib/api/tenants';
import { listSubscriptions } from '../../../lib/api/billing';
import { listPlatformAuditLog } from '../../../lib/api/audit';
import { Alert } from '../../../components/ui/Alert';
import { StatusBadge } from '../../../components/ui/Badge';
import { SegmentedControl } from '../../../components/ui/SegmentedControl';
import { BarBreakdown, ChartCard, DonutChart, KpiCard, Skeleton, TrendAreaChart } from '../../../components/charts';

type Window = '7' | '14' | '30';
const DAY_MS = 86_400_000;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const fmtDay = (iso: string) => new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(`${iso}T00:00:00Z`));
const fmtWhen = (iso: string) => new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
const toRows = (rec: Record<string, number>) => Object.entries(rec).map(([name, value]) => ({ name: titleCase(name), value }));

export default function DashboardPage() {
  const [windowDays, setWindowDays] = useState<Window>('14');
  const overview = useAsync(() => getUsageOverview(), []);
  const tenants = useAsync(() => listTenants().catch(() => null), []);
  const subs = useAsync(() => listSubscriptions().catch(() => null), []);
  const audit = useAsync(() => listPlatformAuditLog({}).catch(() => null), []);
  // Per-tenant usage: cheap existing reads, bounded to the 8 largest-by-recency tenants so this never fans out with fleet size.
  const usage = useAsync(async () => {
    const list = (await listTenants().catch(() => [])).slice(0, 8);
    const rows = await Promise.all(
      list.map((tn) => getTenantUsage(tn.id).then((u) => ({ name: tn.name, active: u.seats.activeEmployees, cap: u.seats.licensedSeatCap ?? 0 })).catch(() => null)),
    );
    return rows.filter((r): r is { name: string; active: number; cap: number } => r !== null);
  }, []);

  const days = Number(windowDays);

  const growth = useMemo(() => {
    const list = tenants.data ?? [];
    const end = new Date();
    const buckets: { day: string; tenants: number }[] = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const day = dayKey(new Date(end.getTime() - i * DAY_MS));
      const total = list.filter((t) => dayKey(new Date(t.createdAt)) <= day).length;
      buckets.push({ day, tenants: total });
    }
    return buckets;
  }, [tenants.data, days]);

  const activity = useMemo(() => {
    const entries = audit.data ?? [];
    const end = new Date();
    return Array.from({ length: days }, (_, k) => {
      const day = dayKey(new Date(end.getTime() - (days - 1 - k) * DAY_MS));
      return { day, events: entries.filter((e) => dayKey(new Date(e.occurredAt)) === day).length };
    });
  }, [audit.data, days]);

  const subStatus = useMemo(() => {
    const out: Record<string, number> = {};
    (subs.data ?? []).forEach((s) => (out[s.status] = (out[s.status] ?? 0) + 1));
    return out;
  }, [subs.data]);
  const seatsBilled = (subs.data ?? []).reduce((n, s) => n + (s.quantity ?? 0), 0);
  const renewals = useMemo(
    () =>
      [...(subs.data ?? [])]
        .filter((s) => s.currentPeriodEnd)
        .sort((a, b) => new Date(a.currentPeriodEnd!).getTime() - new Date(b.currentPeriodEnd!).getTime())
        .slice(0, 5),
    [subs.data],
  );

  if (overview.error) {
    return (
      <Alert tone="error">
        {overview.error}{' '}
        <button type="button" onClick={overview.reload} className="underline">
          Retry
        </button>
      </Alert>
    );
  }

  const o = overview.data;
  const ov = overview.loading && !o;
  const needsAttention = (o?.byStatus.SUSPENDED ?? 0) + (subStatus.PAST_DUE ?? 0);

  return (
    <div className="max-w-[88rem] space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 data-testid="dashboard-heading" className="page-title">
            Platform overview
          </h1>
          <p className="page-subtitle">Cross-tenant health at a glance — precomputed, cheap reads only.</p>
        </div>
        <SegmentedControl
          label="Time window"
          value={windowDays}
          onChange={setWindowDays}
          options={[
            { value: '7', label: '7 days', testId: 'window-7' },
            { value: '14', label: '14 days', testId: 'window-14' },
            { value: '30', label: '30 days', testId: 'window-30' },
          ]}
        />
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-5">
        <KpiCard index={0} loading={ov} icon={Building2} label="Total tenants" value={String(o?.totalTenants ?? 0)} hint={`${o?.byStatus.ACTIVE ?? 0} active`} />
        <KpiCard index={1} loading={ov} icon={Users} label="Active employees" value={new Intl.NumberFormat('en').format(o?.totalActiveEmployees ?? 0)} hint="all tenants" />
        <KpiCard
          index={2}
          loading={subs.loading && !subs.data}
          icon={CreditCard}
          label="Active subscriptions"
          value={String(subStatus.ACTIVE ?? 0)}
          hint={`${new Intl.NumberFormat('en').format(seatsBilled)} seats billed`}
        />
        <KpiCard
          index={3}
          loading={ov}
          icon={needsAttention > 0 ? TriangleAlert : Activity}
          label="Needs attention"
          value={String(needsAttention)}
          hint={`${o?.byStatus.SUSPENDED ?? 0} suspended · ${subStatus.PAST_DUE ?? 0} past due`}
          trend={needsAttention > 0 ? { text: 'Review', dir: 'up', tone: 'bad' } : { text: 'All clear', dir: 'flat', tone: 'good' }}
        />
        <KpiCard index={4} loading={ov} icon={ShieldCheck} label="Platform admins" value={String(o?.totalPlatformAdmins ?? 0)} hint="active" />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <ChartCard className="lg:col-span-2" testId="chart-tenant-growth" title="Tenant growth" subtitle={`Cumulative tenants, last ${days} days`} loading={tenants.loading && !tenants.data} empty={!tenants.data?.length}>
          <TrendAreaChart data={growth} xKey="day" formatX={(v) => fmtDay(String(v))} series={[{ key: 'tenants', label: 'Tenants', color: 0 }]} />
        </ChartCard>
        <ChartCard testId="chart-tenants-status" title="Tenants by status" loading={ov} empty={!o || o.totalTenants === 0}>
          {o && <DonutChart data={toRows(o.byStatus)} centerLabel="Tenants" />}
        </ChartCard>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <ChartCard testId="chart-tenants-edition" title="Tenants by edition" loading={ov} empty={!o || o.totalTenants === 0}>
          {o && <DonutChart data={toRows(o.byEdition)} centerLabel="Tenants" />}
        </ChartCard>
        <ChartCard className="lg:col-span-2" testId="chart-usage" title="Seat usage by tenant" subtitle="Active employees vs licensed seat cap" loading={usage.loading && !usage.data} empty={!usage.data?.length}>
          {usage.data && (
            <BarBreakdown
              horizontal
              height={240}
              data={usage.data}
              xKey="name"
              series={[
                { key: 'active', label: 'Active employees', color: 0 },
                { key: 'cap', label: 'Seat cap', color: 1 },
              ]}
            />
          )}
        </ChartCard>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <ChartCard testId="chart-subscriptions" title="Subscriptions" subtitle="By billing status" loading={subs.loading && !subs.data} empty={!subs.data?.length} emptyText="No subscriptions yet.">
          <DonutChart data={toRows(subStatus)} centerLabel="Subscriptions" />
        </ChartCard>

        <ChartCard testId="chart-activity" title="Platform activity" subtitle={`Audited events, last ${days} days`} loading={audit.loading && !audit.data} empty={!audit.data?.length} emptyText="No audited activity yet.">
          <TrendAreaChart height={200} data={activity} xKey="day" formatX={(v) => fmtDay(String(v))} series={[{ key: 'events', label: 'Events', color: 3 }]} />
        </ChartCard>

        <section className="animate-fade-up rounded-xl2 border border-ink-100 bg-surface shadow-card">
          <header className="flex items-center justify-between gap-3 border-b border-ink-100 px-5 py-4">
            <h2 className="text-sm font-semibold tracking-tight text-ink-900">Recent activity</h2>
            <Link href="/audit" className="text-xs font-semibold text-brand-700 hover:underline">
              View all
            </Link>
          </header>
          <div className="px-5 py-3">
            {audit.loading && !audit.data ? (
              <div className="space-y-3 py-2">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : !audit.data?.length ? (
              <p className="py-8 text-center text-sm text-ink-400">No audited activity yet.</p>
            ) : (
              <ul className="divide-y divide-ink-100">
                {audit.data.slice(0, 6).map((e) => (
                  <li key={e.id} className="py-2.5 text-sm">
                    <p className="truncate font-medium text-ink-800">{e.action}</p>
                    <p className="text-xs text-ink-400">
                      {e.entityType} · {fmtWhen(e.occurredAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      {renewals.length > 0 && (
        <section className="animate-fade-up rounded-xl2 border border-ink-100 bg-surface shadow-card">
          <header className="flex items-center justify-between gap-3 border-b border-ink-100 px-5 py-4">
            <h2 className="text-sm font-semibold tracking-tight text-ink-900">Upcoming renewals</h2>
            <Link href="/billing" className="text-xs font-semibold text-brand-700 hover:underline">
              Billing
            </Link>
          </header>
          <div className="overflow-x-auto px-5 py-2">
            <table className="w-full text-start text-sm">
              <thead>
                <tr className="border-b border-ink-100">
                  <th className="py-2 text-start">Tenant</th>
                  <th className="py-2 text-start">Edition</th>
                  <th className="py-2 text-start">Status</th>
                  <th className="py-2 text-start">Seats</th>
                  <th className="py-2 text-start">Period ends</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {renewals.map((s) => (
                  <tr key={s.tenantId}>
                    <td className="py-2.5 font-medium text-ink-800">{s.tenantName}</td>
                    <td className="py-2.5">
                      <StatusBadge status={s.edition} />
                    </td>
                    <td className="py-2.5">
                      <StatusBadge status={s.status} />
                    </td>
                    <td className="py-2.5 text-ink-600">{s.quantity ?? '—'}</td>
                    <td className="py-2.5 text-ink-600">
                      {fmtDay(s.currentPeriodEnd!.slice(0, 10))}
                      {s.cancelAtPeriodEnd && <span className="ms-2 text-xs text-coral-600">cancels</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
