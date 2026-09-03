'use client';

import { FormEvent, useState } from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { useAsync } from '../../../lib/useAsync';
import { usePlatformAuth } from '../../../lib/auth/PlatformAuthContext';
import { createCountryPack, listCountryPacks } from '../../../lib/api/country-packs';
import { ApiError } from '../../../lib/api/client';
import { Card } from '../../../components/ui/Card';
import { PageSpinner } from '../../../components/ui/Spinner';
import { Alert } from '../../../components/ui/Alert';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Button } from '../../../components/ui/Button';
import { Modal } from '../../../components/ui/Modal';
import { Input, Label } from '../../../components/ui/Field';

const TEMPLATE_CONFIG = JSON.stringify(
  {
    locale: {
      currencyCode: 'USD',
      currencySymbol: '$',
      numberFormat: 'en-US',
      dateFormat: 'MM/DD/YYYY',
      defaultLanguage: 'en',
      rtl: false,
      firstDayOfWeek: 'SUNDAY',
    },
    workingTime: { standardWeeklyHours: 40, weekendDays: ['SATURDAY', 'SUNDAY'], overtimeRules: { multiplier: 1.5 } },
    leaveDefaults: { annualDays: 15, sickDays: 10, maternityDays: 90, paternityDays: 5 },
    publicHolidays: {},
    tax: { layers: [] },
    statutory: { components: [] },
    requiredEmployeeFields: [],
    payslipTemplate: { language: 'en', lineItems: [{ key: 'gross', label: 'Gross Pay' }] },
    payrollMode: 'CALCULATE',
    hostingRegionHint: 'us-east-1',
  },
  null,
  2,
);

export default function CountryPacksPage() {
  const { me } = usePlatformAuth();
  const { data, loading, error, reload } = useAsync(() => listCountryPacks(), []);
  const [showCreate, setShowCreate] = useState(false);
  const canManage = me?.role === 'PLATFORM_OWNER';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Country packs</h1>
          <p className="text-sm text-ink-500">The saleable-asset workshop — legal/cultural config per country, versioned.</p>
        </div>
        {canManage && (
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" aria-hidden /> New country
          </Button>
        )}
      </div>

      {loading && <PageSpinner />}
      {error && <Alert tone="error">{error}</Alert>}
      {data && data.length === 0 && <EmptyState title="No country packs yet" />}

      {data && data.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink-100 bg-sand-50 text-left text-xs font-medium uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-3">Country</th>
                <th className="px-4 py-3">Versions</th>
                <th className="px-4 py-3">Active version</th>
              </tr>
            </thead>
            <tbody>
              {data.map((entry) => {
                const active = entry.versions.find((v) => v.isActive);
                return (
                  <tr key={entry.countryCode} className="border-b border-ink-50 last:border-0 hover:bg-sand-50">
                    <td className="px-4 py-3">
                      <Link href={`/country-packs/${entry.countryCode}`} className="font-medium text-brand-700 hover:underline">
                        {entry.countryCode}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-ink-600">{entry.versions.length}</td>
                    <td className="px-4 py-3 text-ink-600">{active ? `v${active.version}` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {showCreate && (
        <CreateCountryPackModal
          onClose={() => setShowCreate(false)}
          onCreated={reload}
        />
      )}
    </div>
  );
}

function CreateCountryPackModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [countryCode, setCountryCode] = useState('');
  const [configText, setConfigText] = useState(TEMPLATE_CONFIG);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    let config: unknown;
    try {
      config = JSON.parse(configText);
    } catch {
      setError('Config must be valid JSON.');
      return;
    }
    setSubmitting(true);
    try {
      await createCountryPack(countryCode.toUpperCase(), config);
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Create country pack" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <Label htmlFor="countryCode">Country code (ISO 3166-1 alpha-2)</Label>
          <Input id="countryCode" value={countryCode} onChange={(e) => setCountryCode(e.target.value)} maxLength={2} required />
        </div>
        <div>
          <Label htmlFor="config">Config (JSON)</Label>
          <textarea
            id="config"
            value={configText}
            onChange={(e) => setConfigText(e.target.value)}
            className="h-72 w-full rounded-lg border border-ink-200 p-2 font-mono text-xs"
          />
          <p className="mt-1 text-xs text-ink-400">Validated against the existing countryPackConfigSchema on submit and again at activation.</p>
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={submitting}>
            Create (auto-activates as v1)
          </Button>
        </div>
      </form>
    </Modal>
  );
}
