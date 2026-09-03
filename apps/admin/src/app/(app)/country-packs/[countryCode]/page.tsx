'use client';

import { FormEvent, useState } from 'react';
import { useParams } from 'next/navigation';
import { usePlatformAuth } from '../../../../lib/auth/PlatformAuthContext';
import { useAsync } from '../../../../lib/useAsync';
import {
  activateCountryPackVersion,
  createCountryPackVersion,
  listCountryPackVersions,
  updateCountryPackVersion,
} from '../../../../lib/api/country-packs';
import type { CountryPackVersionSummary } from '../../../../lib/api/types';
import { ApiError } from '../../../../lib/api/client';
import { Card, CardBody, CardHeader, CardTitle } from '../../../../components/ui/Card';
import { PageSpinner } from '../../../../components/ui/Spinner';
import { Alert } from '../../../../components/ui/Alert';
import { Button } from '../../../../components/ui/Button';
import { Badge } from '../../../../components/ui/Badge';

export default function CountryPackDetailPage() {
  const params = useParams<{ countryCode: string }>();
  const { me } = usePlatformAuth();
  const canManage = me?.role === 'PLATFORM_OWNER';
  const { data: versions, loading, error, reload } = useAsync(() => listCountryPackVersions(params.countryCode), [params.countryCode]);
  const [editing, setEditing] = useState<CountryPackVersionSummary | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (loading) return <PageSpinner />;
  if (error || !versions) return <Alert tone="error">{error ?? 'Not found.'}</Alert>;

  async function handleNewVersion() {
    setActionError(null);
    try {
      await createCountryPackVersion(params.countryCode);
      reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Something went wrong.');
    }
  }

  async function handleActivate(version: number) {
    setActionError(null);
    try {
      await activateCountryPackVersion(params.countryCode, version);
      reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Something went wrong.');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-ink-900">{params.countryCode}</h1>
        {canManage && <Button onClick={handleNewVersion}>New draft version</Button>}
      </div>

      {actionError && <Alert tone="error">{actionError}</Alert>}

      <div className="space-y-3">
        {versions
          .sort((a, b) => b.version - a.version)
          .map((v) => (
            <Card key={v.version}>
              <CardHeader>
                <CardTitle>
                  Version {v.version} {v.isActive && <Badge tone="success">ACTIVE</Badge>}
                </CardTitle>
                {canManage && (
                  <div className="flex gap-2">
                    {!v.isActive && (
                      <Button size="sm" variant="secondary" onClick={() => setEditing(v)}>
                        Edit
                      </Button>
                    )}
                    {!v.isActive && (
                      <Button size="sm" onClick={() => handleActivate(v.version)}>
                        Activate
                      </Button>
                    )}
                  </div>
                )}
              </CardHeader>
              <CardBody>
                <pre className="max-h-64 overflow-auto rounded-lg bg-sand-50 p-3 text-xs text-ink-700">
                  {JSON.stringify(v.config, null, 2)}
                </pre>
              </CardBody>
            </Card>
          ))}
      </div>

      {editing && (
        <EditVersionModal
          countryCode={params.countryCode}
          version={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function EditVersionModal({
  countryCode,
  version,
  onClose,
  onSaved,
}: {
  countryCode: string;
  version: CountryPackVersionSummary;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [configText, setConfigText] = useState(JSON.stringify(version.config, null, 2));
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
      await updateCountryPackVersion(countryCode, version.version, config);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl2 bg-white p-5 shadow-soft">
        <h2 className="mb-3 text-sm font-semibold text-ink-900">
          Edit {countryCode} v{version.version} (draft)
        </h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <textarea
            value={configText}
            onChange={(e) => setConfigText(e.target.value)}
            className="h-96 w-full rounded-lg border border-ink-200 p-2 font-mono text-xs"
          />
          {error && <Alert tone="error">{error}</Alert>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              Save draft
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
