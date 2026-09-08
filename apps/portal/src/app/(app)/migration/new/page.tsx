'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { IMPORT_ENTITY_FIELDS, IMPORT_ENTITY_TYPES, ImportEntityTypeKey, PERMISSIONS } from '@hrm/shared';
import { useI18n } from '../../../../i18n/I18nProvider';
import { useAuth } from '../../../../lib/auth/AuthContext';
import { ApiError } from '../../../../lib/api/client';
import { createImportBatch, listColumnMappingTemplates, saveColumnMappingTemplate, validateImportBatch } from '../../../../lib/api/migration';
import type { ColumnMappingTemplate } from '../../../../lib/api/types';
import { inferFileFormat, readFileHeaders } from '../../../../lib/migration/read-file-headers';
import { Card, CardBody, CardHeader, CardTitle } from '../../../../components/ui/Card';
import { Button } from '../../../../components/ui/Button';
import { Alert } from '../../../../components/ui/Alert';
import { Input, Label, Select } from '../../../../components/ui/Field';

type Step = 'upload' | 'map';

export default function NewImportPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const router = useRouter();

  const [step, setStep] = useState<Step>('upload');
  const [entityType, setEntityType] = useState<ImportEntityTypeKey>('EMPLOYEE');
  const [mode, setMode] = useState<'PARTIAL' | 'ALL_OR_NOTHING'>('PARTIAL');
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [templates, setTemplates] = useState<ColumnMappingTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [saveAsTemplate, setSaveAsTemplate] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (step !== 'map') return;
    listColumnMappingTemplates(entityType).then(setTemplates).catch(() => setTemplates([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, entityType]);

  if (!can(PERMISSIONS.MIGRATION_MANAGE)) {
    return <Alert tone="info">{t('migration.noAccess')}</Alert>;
  }

  const fields = IMPORT_ENTITY_FIELDS[entityType];
  const missingRequired = fields.filter((f) => f.required && !mapping[f.key]);

  async function handleContinueToMapping() {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const detected = await readFileHeaders(file);
      setHeaders(detected);
      setMapping({});
      setSelectedTemplateId('');
      setStep('map');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setBusy(false);
    }
  }

  function applyTemplate(templateId: string) {
    setSelectedTemplateId(templateId);
    const template = templates.find((tpl) => tpl.id === templateId);
    if (template) setMapping(template.mapping);
  }

  async function handleRunDryRun() {
    if (!file || missingRequired.length > 0) return;
    setError(null);
    setBusy(true);
    try {
      if (saveAsTemplate && templateName.trim()) {
        await saveColumnMappingTemplate({ name: templateName.trim(), entityType, mapping });
      }
      const batch = await createImportBatch({
        entityType,
        fileFormat: inferFileFormat(file),
        mode,
        columnMapping: mapping,
        columnMappingTemplateId: selectedTemplateId || undefined,
        file,
      });
      await validateImportBatch(batch.id);
      router.push(`/migration/${batch.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-xl font-semibold text-ink-900">{t('migration.newImport')}</h1>

      {error && <Alert tone="error">{error}</Alert>}

      {step === 'upload' && (
        <Card>
          <CardHeader>
            <CardTitle>{t('migration.step.upload')}</CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            <div>
              <Label htmlFor="import-entity-type">{t('migration.entityType')}</Label>
              <Select
                id="import-entity-type"
                value={entityType}
                onChange={(e) => setEntityType(e.target.value as ImportEntityTypeKey)}
                data-testid="import-entity-type-select"
              >
                {IMPORT_ENTITY_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`migration.entityType.${type}`)}
                  </option>
                ))}
              </Select>
            </div>

            <div>
              <Label htmlFor="import-mode">{t('migration.upload.mode')}</Label>
              <Select id="import-mode" value={mode} onChange={(e) => setMode(e.target.value as 'PARTIAL' | 'ALL_OR_NOTHING')}>
                <option value="PARTIAL">{t('migration.upload.modePartial')}</option>
                <option value="ALL_OR_NOTHING">{t('migration.upload.modeAllOrNothing')}</option>
              </Select>
            </div>

            <div>
              <Label htmlFor="import-file">{t('migration.upload.file')}</Label>
              <input
                id="import-file"
                type="file"
                accept=".csv,.xlsx"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block text-sm text-ink-600"
                data-testid="import-file-input"
              />
            </div>

            <div className="flex justify-end">
              <Button onClick={handleContinueToMapping} disabled={!file} loading={busy} data-testid="continue-to-mapping-button">
                {t('migration.upload.continue')}
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {step === 'map' && (
        <Card>
          <CardHeader>
            <CardTitle>{t('migration.mapping.title')}</CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            <p className="text-sm text-ink-500">{t('migration.mapping.subtitle')}</p>

            {templates.length > 0 && (
              <div>
                <Label htmlFor="mapping-template-select">{t('migration.mapping.useTemplate')}</Label>
                <Select id="mapping-template-select" value={selectedTemplateId} onChange={(e) => applyTemplate(e.target.value)} data-testid="mapping-template-select">
                  <option value="">{t('migration.mapping.selectTemplate')}</option>
                  {templates.map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>
                      {tpl.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}

            <div className="overflow-x-auto rounded-lg border border-ink-100">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-100 bg-sand-50 text-left text-ink-500">
                    <th className="px-3 py-2">{t('migration.mapping.ourField')}</th>
                    <th className="px-3 py-2">{t('migration.mapping.yourColumn')}</th>
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
                          data-testid={`mapping-select-${field.key}`}
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

            <div className="space-y-2 rounded-lg bg-sand-50 p-3">
              <label className="flex items-center gap-2 text-sm text-ink-700">
                <input type="checkbox" checked={saveAsTemplate} onChange={(e) => setSaveAsTemplate(e.target.checked)} />
                {t('migration.mapping.saveAsTemplate')}
              </label>
              {saveAsTemplate && (
                <Input
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  placeholder={t('migration.mapping.templateName')}
                  data-testid="mapping-template-name-input"
                />
              )}
            </div>

            {missingRequired.length > 0 && <Alert tone="info">{t('migration.mapping.missing')}</Alert>}

            <div className="flex justify-between border-t border-ink-100 pt-4">
              <Button type="button" variant="secondary" onClick={() => setStep('upload')}>
                {t('migration.back')}
              </Button>
              <Button
                onClick={handleRunDryRun}
                disabled={missingRequired.length > 0}
                loading={busy}
                data-testid="run-dry-run-button"
              >
                {t('migration.mapping.runDryRun')}
              </Button>
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
