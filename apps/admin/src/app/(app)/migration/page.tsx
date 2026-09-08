'use client';

import { useEffect, useState } from 'react';
import { IMPORT_ENTITY_FIELDS, IMPORT_ENTITY_TYPES, ImportEntityTypeKey } from '@hrm/shared';
import { useAsync } from '../../../lib/useAsync';
import { ApiError } from '../../../lib/api/client';
import { listTenants } from '../../../lib/api/tenants';
import {
  commitPlatformImportBatch,
  createPlatformImportBatch,
  downloadPlatformImportErrorReport,
  getPlatformImportBatch,
  listPlatformImportRowErrors,
  validatePlatformImportBatch,
} from '../../../lib/api/migration';
import type { ImportBatch, ImportRowError } from '../../../lib/api/types';
import { inferFileFormat, readFileHeaders } from '../../../lib/migration/read-file-headers';
import { Card, CardBody, CardHeader, CardTitle } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Alert } from '../../../components/ui/Alert';
import { Label, Select } from '../../../components/ui/Field';
import { PageSpinner } from '../../../components/ui/Spinner';
import { StatusBadge } from '../../../components/ui/Badge';
import { EmptyState } from '../../../components/ui/EmptyState';

/**
 * Vendor onboarding data import (step 3.5.1) — run/oversee a data import on
 * a tenant's behalf during onboarding, see docs/conventions/vendor-console.md
 * and docs/conventions/data-migration.md. One consolidated page, the SAME
 * "functional over fancy" posture this console already takes for country-
 * pack authoring: a support engineer picks a tenant, uploads a file, maps
 * columns, and drives the identical dry-run/commit lifecycle a tenant's own
 * `/migration` self-serve UI uses — every write is dual-audited server-side
 * (this page needs no extra plumbing for that).
 */
export default function PlatformMigrationPage() {
  const { data: tenants, loading: tenantsLoading, error: tenantsError } = useAsync(() => listTenants(), []);
  const [tenantId, setTenantId] = useState('');
  const [entityType, setEntityType] = useState<ImportEntityTypeKey>('EMPLOYEE');
  const [mode, setMode] = useState<'PARTIAL' | 'ALL_OR_NOTHING'>('PARTIAL');
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [mapped, setMapped] = useState(false);
  const [batch, setBatch] = useState<ImportBatch | null>(null);
  const [rowErrors, setRowErrors] = useState<ImportRowError[]>([]);
  const [confirmingCommit, setConfirmingCommit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBatch(null);
    setMapped(false);
    setFile(null);
    setHeaders([]);
    setMapping({});
  }, [tenantId]);

  const fields = IMPORT_ENTITY_FIELDS[entityType];
  const missingRequired = fields.filter((f) => f.required && !mapping[f.key]);

  async function handleReadHeaders() {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const detected = await readFileHeaders(file);
      setHeaders(detected);
      setMapping({});
      setMapped(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function refreshBatch(id: string) {
    const [next, errors] = await Promise.all([getPlatformImportBatch(tenantId, id), listPlatformImportRowErrors(tenantId, id)]);
    setBatch(next);
    setRowErrors(errors);
  }

  async function handleRunDryRun() {
    if (!file || missingRequired.length > 0) return;
    setError(null);
    setBusy(true);
    try {
      const created = await createPlatformImportBatch(tenantId, { entityType, fileFormat: inferFileFormat(file), mode, columnMapping: mapping, file });
      await validatePlatformImportBatch(tenantId, created.id);
      await refreshBatch(created.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function handleCommit() {
    if (!batch) return;
    setConfirmingCommit(false);
    setError(null);
    setBusy(true);
    try {
      await commitPlatformImportBatch(tenantId, batch.id);
      await refreshBatch(batch.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">Onboarding data import</h1>
        <p className="text-sm text-ink-500">Run or oversee a data import on a tenant&apos;s behalf during onboarding.</p>
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {tenantsError && <Alert tone="error">{tenantsError}</Alert>}

      <Card>
        <CardHeader>
          <CardTitle>Tenant</CardTitle>
        </CardHeader>
        <CardBody>
          {tenantsLoading ? (
            <PageSpinner />
          ) : (
            <Select value={tenantId} onChange={(e) => setTenantId(e.target.value)} data-testid="platform-migration-tenant-select">
              <option value="">Select a tenant…</option>
              {(tenants ?? []).map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name} ({tenant.slug})
                </option>
              ))}
            </Select>
          )}
        </CardBody>
      </Card>

      {tenantId && !batch && (
        <Card>
          <CardHeader>
            <CardTitle>{mapped ? 'Map columns' : 'Upload'}</CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            {!mapped ? (
              <>
                <div>
                  <Label htmlFor="platform-import-entity-type">What are you importing?</Label>
                  <Select
                    id="platform-import-entity-type"
                    value={entityType}
                    onChange={(e) => setEntityType(e.target.value as ImportEntityTypeKey)}
                    data-testid="platform-migration-entity-type-select"
                  >
                    {IMPORT_ENTITY_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type.replace(/_/g, ' ')}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label htmlFor="platform-import-mode">On row errors</Label>
                  <Select id="platform-import-mode" value={mode} onChange={(e) => setMode(e.target.value as 'PARTIAL' | 'ALL_OR_NOTHING')}>
                    <option value="PARTIAL">Import valid rows, report the rest</option>
                    <option value="ALL_OR_NOTHING">All or nothing</option>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="platform-import-file">Spreadsheet file (.csv or .xlsx)</Label>
                  <input
                    id="platform-import-file"
                    type="file"
                    accept=".csv,.xlsx"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    className="block text-sm text-ink-600"
                    data-testid="platform-migration-file-input"
                  />
                </div>
                <div className="flex justify-end">
                  <Button onClick={handleReadHeaders} disabled={!file} loading={busy} data-testid="platform-migration-continue-button">
                    Continue to column mapping
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="overflow-x-auto rounded-lg border border-ink-100">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-ink-100 bg-sand-50 text-left text-ink-500">
                        <th className="px-3 py-2">Field</th>
                        <th className="px-3 py-2">Your column</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fields.map((field) => (
                        <tr key={field.key} className="border-b border-ink-50 last:border-0">
                          <td className="px-3 py-2 text-ink-800">
                            {field.label}
                            {field.required && <span className="ml-1 text-coral-500">*</span>}
                          </td>
                          <td className="px-3 py-2">
                            <Select
                              value={mapping[field.key] ?? ''}
                              onChange={(e) => setMapping((m) => ({ ...m, [field.key]: e.target.value }))}
                              data-testid={`platform-mapping-select-${field.key}`}
                            >
                              <option value="">—</option>
                              {headers.map((header) => (
                                <option key={header} value={header}>
                                  {header}
                                </option>
                              ))}
                            </Select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {missingRequired.length > 0 && <Alert tone="info">Map every required field before running the dry run.</Alert>}
                <div className="flex justify-between border-t border-ink-100 pt-4">
                  <Button type="button" variant="secondary" onClick={() => setMapped(false)}>
                    Back
                  </Button>
                  <Button onClick={handleRunDryRun} disabled={missingRequired.length > 0} loading={busy} data-testid="platform-migration-run-dry-run-button">
                    Run dry run
                  </Button>
                </div>
              </>
            )}
          </CardBody>
        </Card>
      )}

      {batch && (
        <Card>
          <CardHeader>
            <CardTitle>{batch.entityType.replace(/_/g, ' ')}</CardTitle>
            <div className="flex items-center gap-2">
              <StatusBadge status={batch.status} />
              <Button variant="ghost" size="sm" onClick={() => refreshBatch(batch.id)} data-testid="platform-migration-refresh-button">
                Refresh
              </Button>
            </div>
          </CardHeader>
          <CardBody className="space-y-4">
            {batch.failureReason && <Alert tone="error">{batch.failureReason}</Alert>}
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Will create" value={batch.createCount} />
              <Stat label="Will update" value={batch.updateCount} />
              <Stat label="Will skip" value={batch.skipCount} />
              <Stat label="Row errors" value={batch.errorCount} />
            </div>

            {rowErrors.length === 0 ? (
              <EmptyState title="No row errors" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-ink-100 text-left text-ink-500">
                      <th className="py-2 pr-4">#</th>
                      <th className="py-2 pr-4">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rowErrors.map((rowError) => (
                      <tr key={rowError.id} data-testid="platform-import-row-error" className="border-b border-ink-50">
                        <td className="py-2 pr-4 text-ink-500">{rowError.rowNumber}</td>
                        <td className="py-2 pr-4 text-ink-700">{rowError.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex justify-end gap-2 border-t border-ink-100 pt-4">
              {batch.errorCount > 0 && (
                <Button variant="secondary" onClick={() => downloadPlatformImportErrorReport(tenantId, batch.id)}>
                  Download error report (CSV)
                </Button>
              )}
              {batch.status === 'DRY_RUN_COMPLETE' && !confirmingCommit && (
                <Button loading={busy} onClick={() => setConfirmingCommit(true)} data-testid="platform-migration-commit-button">
                  Commit import
                </Button>
              )}
              {confirmingCommit && (
                <div className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  <span>This will write the rows above to the tenant&apos;s live data. Continue?</span>
                  <Button variant="secondary" size="sm" onClick={() => setConfirmingCommit(false)}>
                    Cancel
                  </Button>
                  <Button size="sm" loading={busy} onClick={handleCommit} data-testid="platform-migration-confirm-commit-button">
                    Commit import
                  </Button>
                </div>
              )}
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-ink-400">{label}</p>
      <p className="text-2xl font-semibold text-ink-900">{value}</p>
    </div>
  );
}
