'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { Download, RefreshCw, Upload } from 'lucide-react';
import { EDUCATION_LEVELS, UpdateParsedResumeInput } from '@hrm/shared';
import type { EducationLevel, ParsedResume } from '@hrm/shared';
import { useI18n } from '../../i18n/I18nProvider';
import { ApiError } from '../../lib/api/client';
import { triggerBrowserDownload } from '../../lib/download';
import { downloadCandidateResume, reparseCandidateResume, updateParsedResume, uploadCandidateResume } from '../../lib/api/screening';
import type { ParseStatus } from '../../lib/api/screening';
import { Alert } from '../ui/Alert';
import { Badge, StatusBadge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Input, Label, Select, Textarea } from '../ui/Field';

type Parsed = Omit<ParsedResume, 'rawText'>;

export interface ParsedResumePanelProps {
  candidateId: string;
  hasResume: boolean;
  resumeFileName?: string | null;
  parse: { status: ParseStatus; error: string | null; parserName: string | null; editedAt: string | null; parsedAt?: string | null };
  parsed: Parsed | null;
  canWrite: boolean;
  /** Re-fetch the data this panel renders from (also called silently while a parse is PENDING). */
  onChanged: () => void;
}

const POLL_MS = 2500;

/**
 * The recruiter's view of one candidate's resume: the original file
 * (download/replace), the parse status, and the parsed fields — read-only by
 * default, editable on demand. Polls while the async parse is PENDING so the
 * fields appear without a manual refresh.
 */
export function ParsedResumePanel({ candidateId, hasResume, resumeFileName, parse, parsed, canWrite, onChanged }: ParsedResumePanelProps) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmReparse, setConfirmReparse] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (parse.status !== 'PENDING') return;
    const timer = setInterval(onChanged, POLL_MS);
    return () => clearInterval(timer);
  }, [parse.status, onChanged]);

  async function run(label: string, action: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setBusy(null);
    }
  }

  const sourceNote = parse.parserName === 'manual' ? t('screening.parse.manual') : parse.editedAt ? t('screening.parse.edited') : null;

  return (
    <div className="space-y-4" data-testid="parsed-resume-panel" data-parse-status={parse.status}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-ink-900">{t('screening.resume')}</h2>
          <StatusBadge status={parse.status} label={t(`screening.parse.${parse.status}`)} />
          {sourceNote && <Badge tone="info">{sourceNote}</Badge>}
          {parse.parserName && parse.parserName !== 'manual' && parse.status === 'PARSED' && !parse.editedAt && (
            <span className="text-xs text-ink-400">{t('screening.parse.parser', { name: parse.parserName })}</span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {hasResume && (
            <Button
              size="sm"
              variant="secondary"
              data-testid="download-resume-button"
              loading={busy === 'download'}
              onClick={() =>
                run('download', async () => {
                  const { blob, filename } = await downloadCandidateResume(candidateId);
                  triggerBrowserDownload(blob, filename ?? resumeFileName ?? 'resume');
                })
              }
            >
              <Download className="h-4 w-4" aria-hidden />
              {t('screening.resume.download')}
            </Button>
          )}
          {canWrite && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,.docx,.txt,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                className="sr-only"
                data-testid="resume-file-input"
                aria-label={t('screening.resume.upload')}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void run('upload', async () => { await uploadCandidateResume(candidateId, file); onChanged(); });
                }}
              />
              <Button size="sm" variant="secondary" loading={busy === 'upload'} onClick={() => fileRef.current?.click()} data-testid="upload-resume-button">
                <Upload className="h-4 w-4" aria-hidden />
                {hasResume ? t('screening.resume.replace') : t('screening.resume.upload')}
              </Button>
              {hasResume && (
                <Button size="sm" variant="secondary" data-testid="reparse-button" disabled={parse.status === 'PENDING'} onClick={() => setConfirmReparse(true)}>
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  {t('screening.resume.reparse')}
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {!hasResume && parse.status !== 'PARSED' && <p className="text-sm text-ink-400">{t('screening.resume.none')}</p>}
      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      {parse.status === 'PENDING' && (
        <Alert tone="info">
          <span data-testid="parse-pending">{t('screening.parse.pendingHelp')}</span>
        </Alert>
      )}
      {parse.status === 'FAILED' && (
        <Alert tone="info">
          <span data-testid="parse-failed">{t('screening.parse.failedHelp', { error: parse.error ?? '—' })}</span>
        </Alert>
      )}

      {editing ? (
        <ParsedResumeEditor
          initial={parsed}
          onCancel={() => setEditing(false)}
          onSave={async (input) => {
            await updateParsedResume(candidateId, input);
            setEditing(false);
            setNotice(t('screening.parsed.saved'));
            onChanged();
          }}
        />
      ) : parsed ? (
        <ParsedFieldsView parsed={parsed} onEdit={canWrite ? () => setEditing(true) : undefined} />
      ) : (
        canWrite &&
        parse.status !== 'PENDING' && (
          <Button size="sm" variant="secondary" data-testid="enter-manually-button" onClick={() => setEditing(true)}>
            {t('screening.parsed.enter')}
          </Button>
        )
      )}

      {confirmReparse && (
        <ConfirmDialog
          title={t('screening.resume.reparse')}
          body={t('screening.resume.reparseConfirm')}
          confirmLabel={t('screening.resume.reparse')}
          onClose={() => setConfirmReparse(false)}
          onConfirm={async () => {
            await reparseCandidateResume(candidateId);
            setConfirmReparse(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function ParsedFieldsView({ parsed, onEdit }: { parsed: Parsed; onEdit?: () => void }) {
  const { t } = useI18n();
  return (
    <div className="space-y-4 rounded-lg border border-ink-100 p-4" data-testid="parsed-fields">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-ink-400">{t('screening.parse.autoNote')}</p>
        {onEdit && (
          <Button size="sm" variant="secondary" data-testid="edit-parsed-button" onClick={onEdit}>
            {t('screening.parsed.edit')}
          </Button>
        )}
      </div>
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Field label={t('screening.field.fullName')} value={parsed.fullName} />
        <Field label={t('screening.email')} value={parsed.email} />
        <Field label={t('screening.phone')} value={parsed.phone} />
        <Field label={t('screening.field.totalYears')} value={parsed.totalYearsExperience != null ? t('screening.yearsShort', { n: parsed.totalYearsExperience }) : null} />
      </dl>
      {parsed.summary && <Field label={t('screening.field.summary')} value={parsed.summary} />}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">{t('screening.field.skills')}</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="parsed-skills">
          {parsed.skills.length === 0 ? <span className="text-sm text-ink-400">—</span> : parsed.skills.map((s) => <Badge key={s}>{s}</Badge>)}
        </div>
      </div>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">{t('screening.field.experience')}</p>
        {parsed.experience.length === 0 ? (
          <p className="text-sm text-ink-400">—</p>
        ) : (
          <ul className="mt-1.5 space-y-1.5 text-sm text-ink-700">
            {parsed.experience.map((e, i) => (
              <li key={i}>
                <span className="font-medium text-ink-900">{e.title || '—'}</span>
                {e.company ? ` · ${e.company}` : ''}
                <span className="text-ink-400" dir="ltr">
                  {' '}
                  ({e.startDate ?? '?'} – {e.endDate ?? '?'})
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">{t('screening.field.education')}</p>
        {parsed.education.length === 0 ? (
          <p className="text-sm text-ink-400">—</p>
        ) : (
          <ul className="mt-1.5 space-y-1 text-sm text-ink-700">
            {parsed.education.map((e, i) => (
              <li key={i}>
                {e.level ? <Badge tone="info">{t(`screening.education.${e.level}`)}</Badge> : null} {e.degree ?? ''}
                {e.institution ? ` · ${e.institution}` : ''}
                {e.endYear ? ` (${e.endYear})` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
      {parsed.links.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">{t('screening.field.links')}</p>
          <ul className="mt-1 space-y-0.5 text-sm text-ink-700" dir="ltr">
            {parsed.links.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-ink-400">{label}</dt>
      <dd className="mt-0.5 text-ink-800">{value || '—'}</dd>
    </div>
  );
}

const blankToNull = (s: string): string | null => (s.trim() === '' ? null : s.trim());

interface ExperienceRow { title: string; company: string; startDate: string; endDate: string; description: string }
interface EducationRow { degree: string; field: string; institution: string; level: EducationLevel | ''; endYear: string }

function ParsedResumeEditor({ initial, onSave, onCancel }: { initial: Parsed | null; onSave: (input: UpdateParsedResumeInput) => Promise<void>; onCancel: () => void }) {
  const { t } = useI18n();
  const [fullName, setFullName] = useState(initial?.fullName ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const [years, setYears] = useState(initial?.totalYearsExperience != null ? String(initial.totalYearsExperience) : '');
  const [skills, setSkills] = useState((initial?.skills ?? []).join(', '));
  const [links, setLinks] = useState((initial?.links ?? []).join('\n'));
  const [experience, setExperience] = useState<ExperienceRow[]>(
    (initial?.experience ?? []).map((e) => ({ title: e.title ?? '', company: e.company ?? '', startDate: e.startDate ?? '', endDate: e.endDate ?? '', description: e.description ?? '' })),
  );
  const [education, setEducation] = useState<EducationRow[]>(
    (initial?.education ?? []).map((e) => ({ degree: e.degree ?? '', field: e.field ?? '', institution: e.institution ?? '', level: e.level ?? '', endYear: e.endYear ? String(e.endYear) : '' })),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave({
        fullName: blankToNull(fullName),
        email: blankToNull(email),
        phone: blankToNull(phone),
        summary: blankToNull(summary),
        totalYearsExperience: years.trim() === '' ? null : Number(years),
        skills: skills.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
        links: links.split('\n').map((s) => s.trim()).filter(Boolean),
        experience: experience.map((x) => ({ title: blankToNull(x.title), company: blankToNull(x.company), startDate: blankToNull(x.startDate), endDate: blankToNull(x.endDate), description: blankToNull(x.description) })),
        education: education.map((x) => ({ degree: blankToNull(x.degree), field: blankToNull(x.field), institution: blankToNull(x.institution), level: x.level === '' ? null : x.level, endYear: x.endYear.trim() === '' ? null : Number(x.endYear) })),
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border border-ink-200 p-4" data-testid="parsed-editor">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="pr-name">{t('screening.field.fullName')}</Label>
          <Input id="pr-name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="pr-email">{t('screening.email')}</Label>
          <Input id="pr-email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="pr-phone">{t('screening.phone')}</Label>
          <Input id="pr-phone" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="pr-years">{t('screening.field.totalYears')}</Label>
          <Input id="pr-years" data-testid="parsed-years-input" type="number" min={0} max={70} step="0.1" value={years} onChange={(e) => setYears(e.target.value)} />
        </div>
      </div>
      <div>
        <Label htmlFor="pr-skills">
          {t('screening.field.skills')} ({t('screening.commaHint')})
        </Label>
        <Textarea id="pr-skills" data-testid="parsed-skills-input" rows={2} value={skills} onChange={(e) => setSkills(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="pr-summary">{t('screening.field.summary')}</Label>
        <Textarea id="pr-summary" rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink-800">{t('screening.field.experience')}</legend>
        {experience.map((row, i) => (
          <div key={i} className="grid gap-2 rounded-lg border border-ink-100 p-2 sm:grid-cols-4">
            <Input aria-label={t('screening.exp.title')} placeholder={t('screening.exp.title')} value={row.title} onChange={(e) => setExperience(experience.map((r, j) => (j === i ? { ...r, title: e.target.value } : r)))} />
            <Input aria-label={t('screening.exp.company')} placeholder={t('screening.exp.company')} value={row.company} onChange={(e) => setExperience(experience.map((r, j) => (j === i ? { ...r, company: e.target.value } : r)))} />
            <Input aria-label={t('screening.exp.start')} placeholder={t('screening.exp.start')} dir="ltr" value={row.startDate} onChange={(e) => setExperience(experience.map((r, j) => (j === i ? { ...r, startDate: e.target.value } : r)))} />
            <div className="flex gap-2">
              <Input aria-label={t('screening.exp.end')} placeholder={t('screening.exp.end')} dir="ltr" value={row.endDate} onChange={(e) => setExperience(experience.map((r, j) => (j === i ? { ...r, endDate: e.target.value } : r)))} />
              <Button type="button" size="sm" variant="secondary" aria-label={t('screening.remove')} onClick={() => setExperience(experience.filter((_, j) => j !== i))}>
                ×
              </Button>
            </div>
          </div>
        ))}
        <Button type="button" size="sm" variant="secondary" onClick={() => setExperience([...experience, { title: '', company: '', startDate: '', endDate: '', description: '' }])}>
          {t('screening.exp.add')}
        </Button>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink-800">{t('screening.field.education')}</legend>
        {education.map((row, i) => (
          <div key={i} className="grid gap-2 rounded-lg border border-ink-100 p-2 sm:grid-cols-5">
            <Input aria-label={t('screening.edu.degree')} placeholder={t('screening.edu.degree')} value={row.degree} onChange={(e) => setEducation(education.map((r, j) => (j === i ? { ...r, degree: e.target.value } : r)))} />
            <Input aria-label={t('screening.edu.institution')} placeholder={t('screening.edu.institution')} value={row.institution} onChange={(e) => setEducation(education.map((r, j) => (j === i ? { ...r, institution: e.target.value } : r)))} />
            <Select aria-label={t('screening.edu.level')} value={row.level} onChange={(e) => setEducation(education.map((r, j) => (j === i ? { ...r, level: e.target.value as EducationLevel | '' } : r)))}>
              <option value="">{t('screening.edu.level')}</option>
              {EDUCATION_LEVELS.filter((l) => l !== 'NONE').map((l) => (
                <option key={l} value={l}>
                  {t(`screening.education.${l}`)}
                </option>
              ))}
            </Select>
            <Input aria-label={t('screening.edu.year')} placeholder={t('screening.edu.year')} type="number" dir="ltr" value={row.endYear} onChange={(e) => setEducation(education.map((r, j) => (j === i ? { ...r, endYear: e.target.value } : r)))} />
            <Button type="button" size="sm" variant="secondary" aria-label={t('screening.remove')} onClick={() => setEducation(education.filter((_, j) => j !== i))}>
              ×
            </Button>
          </div>
        ))}
        <Button type="button" size="sm" variant="secondary" onClick={() => setEducation([...education, { degree: '', field: '', institution: '', level: '', endYear: '' }])}>
          {t('screening.edu.add')}
        </Button>
      </fieldset>

      <div>
        <Label htmlFor="pr-links">{t('screening.field.links')}</Label>
        <Textarea id="pr-links" dir="ltr" rows={2} value={links} onChange={(e) => setLinks(e.target.value)} />
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex justify-end gap-2 border-t border-ink-100 pt-3">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" loading={saving} data-testid="save-parsed-button">
          {t('action.save')}
        </Button>
      </div>
    </form>
  );
}
