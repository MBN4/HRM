import { apiFetch, apiFetchBlob } from './client';
import type {
  ParsedResume,
  RankedApplicationsQuery,
  ScreeningCriteriaConfig,
  ScreeningCriteriaConfigInput,
  ScreeningResult,
  UpdateParsedResumeInput,
} from '@hrm/shared';
import type { ApplicationStage } from './types';

export type ParseStatus = 'NONE' | 'PENDING' | 'PARSED' | 'FAILED';

export interface RankedApplication {
  applicationId: string;
  candidateId: string;
  jobPostingId: string;
  jobPostingTitle: string;
  stage: ApplicationStage;
  appliedAt: string;
  candidate: {
    firstName: string;
    lastName: string;
    email: string;
    parseStatus: ParseStatus;
    edited: boolean;
    skills: string[];
    totalYearsExperience: number | null;
    highestEducation: string | null;
  };
  screeningScore: number | null;
  belowThreshold: boolean;
  screening: ScreeningResult | null;
}

export interface ScreeningCriteriaView {
  requisitionId: string;
  config: ScreeningCriteriaConfig | null;
  updatedAt: string | null;
}

export interface ApplicationScreeningView {
  applicationId: string;
  stage: ApplicationStage;
  jobPosting: { id: string; title: string; requisitionId: string };
  candidate: { id: string; firstName: string; lastName: string; email: string; phone: string | null; hasResume: boolean; resumeFileName: string | null };
  parse: { status: ParseStatus; error: string | null; parserName: string | null; parsedAt: string | null; editedAt: string | null };
  parsed: Omit<ParsedResume, 'rawText'> | null;
  screening: ScreeningResult | null;
  screeningScore: number | null;
  belowThreshold: boolean;
  criteria: ScreeningCriteriaConfig | null;
}

export function getScreeningCriteria(requisitionId: string): Promise<ScreeningCriteriaView> {
  return apiFetch(`/recruitment/requisitions/${requisitionId}/screening-criteria`);
}

export function saveScreeningCriteria(requisitionId: string, input: ScreeningCriteriaConfigInput): Promise<ScreeningCriteriaView & { rescored: number }> {
  return apiFetch(`/recruitment/requisitions/${requisitionId}/screening-criteria`, { method: 'PUT', body: input });
}

export function listRankedApplications(requisitionId: string, query: Partial<RankedApplicationsQuery> = {}): Promise<RankedApplication[]> {
  const q: Record<string, string | number | boolean | undefined> = { ...query };
  return apiFetch(`/recruitment/requisitions/${requisitionId}/ranked-applications`, { query: q });
}

export function getApplicationScreening(applicationId: string): Promise<ApplicationScreeningView> {
  return apiFetch(`/recruitment/applications/${applicationId}/screening`);
}

export function updateParsedResume(candidateId: string, input: UpdateParsedResumeInput): Promise<Omit<ParsedResume, 'rawText'>> {
  return apiFetch(`/recruitment/candidates/${candidateId}/parsed-resume`, { method: 'PATCH', body: input });
}

export function uploadCandidateResume(candidateId: string, file: File): Promise<{ candidateId: string; parseStatus: ParseStatus }> {
  const form = new FormData();
  form.append('resume', file);
  return apiFetch(`/recruitment/candidates/${candidateId}/resume`, { method: 'POST', body: form });
}

export function reparseCandidateResume(candidateId: string): Promise<{ candidateId: string; parseStatus: ParseStatus }> {
  return apiFetch(`/recruitment/candidates/${candidateId}/reparse`, { method: 'POST' });
}

export function downloadCandidateResume(candidateId: string) {
  return apiFetchBlob(`/recruitment/candidates/${candidateId}/resume`);
}

export function addApplicant(postingId: string, input: { firstName: string; lastName: string; email: string; phone?: string }, resume?: File) {
  const form = new FormData();
  for (const [k, v] of Object.entries(input)) if (v) form.append(k, v);
  if (resume) form.append('resume', resume);
  return apiFetch<{ id: string }>(`/recruitment/postings/${postingId}/applicants`, { method: 'POST', body: form });
}
