import { apiFetch } from './client';
import type {
  Application,
  ApplicationStage,
  Candidate,
  Interview,
  InterviewScorecard,
  JobPosting,
  JobRequisition,
  Offer,
  RecruitmentEmploymentType,
  ScorecardRecommendation,
} from './types';

export interface CreateJobRequisitionInput {
  title: string;
  branchId: string;
  departmentId?: string;
  designationId?: string;
  employmentType: RecruitmentEmploymentType;
  headcount: number;
  justification?: string;
}

export function createJobRequisition(input: CreateJobRequisitionInput): Promise<JobRequisition> {
  return apiFetch<JobRequisition>('/recruitment/requisitions', { method: 'POST', body: input });
}

export function submitJobRequisitionForApproval(id: string): Promise<{ submitted: boolean }> {
  return apiFetch(`/recruitment/requisitions/${id}/submit-for-approval`, { method: 'POST' });
}

export function closeJobRequisition(id: string): Promise<JobRequisition> {
  return apiFetch<JobRequisition>(`/recruitment/requisitions/${id}/close`, { method: 'POST' });
}

export function listJobRequisitions(params: { status?: string; branchId?: string } = {}): Promise<JobRequisition[]> {
  return apiFetch<JobRequisition[]>('/recruitment/requisitions', { query: params });
}

export function getJobRequisition(id: string): Promise<JobRequisition> {
  return apiFetch<JobRequisition>(`/recruitment/requisitions/${id}`);
}

export interface CreateJobPostingInput {
  requisitionId: string;
  title: string;
  description: string;
  publicSlug: string;
}

export function createJobPosting(input: CreateJobPostingInput): Promise<JobPosting> {
  return apiFetch<JobPosting>('/recruitment/postings', { method: 'POST', body: input });
}

export function publishJobPosting(id: string): Promise<JobPosting> {
  return apiFetch<JobPosting>(`/recruitment/postings/${id}/publish`, { method: 'POST' });
}

export function closeJobPosting(id: string): Promise<JobPosting> {
  return apiFetch<JobPosting>(`/recruitment/postings/${id}/close`, { method: 'POST' });
}

export function listJobPostings(params: { status?: string } = {}): Promise<JobPosting[]> {
  return apiFetch<JobPosting[]>('/recruitment/postings', { query: params });
}

export function getJobPosting(id: string): Promise<JobPosting> {
  return apiFetch<JobPosting>(`/recruitment/postings/${id}`);
}

export function listCandidates(): Promise<Candidate[]> {
  return apiFetch<Candidate[]>('/recruitment/candidates');
}

export function getCandidate(id: string): Promise<Candidate> {
  return apiFetch<Candidate>(`/recruitment/candidates/${id}`);
}

export function listApplications(params: { jobPostingId?: string; candidateId?: string; stage?: string } = {}): Promise<Application[]> {
  return apiFetch<Application[]>('/recruitment/applications', { query: params });
}

export function getApplication(id: string): Promise<Application> {
  return apiFetch<Application>(`/recruitment/applications/${id}`);
}

export function updateApplicationStage(id: string, stage: ApplicationStage): Promise<Application> {
  return apiFetch<Application>(`/recruitment/applications/${id}/stage`, { method: 'PATCH', body: { stage } });
}

export interface ScheduleInterviewInput {
  applicationId: string;
  scheduledAt: string;
  durationMinutes: number;
  interviewerUserIds: string[];
  location?: string;
}

export function scheduleInterview(input: ScheduleInterviewInput): Promise<Interview> {
  return apiFetch<Interview>('/recruitment/interviews', { method: 'POST', body: input });
}

export function listInterviewsForApplication(applicationId: string): Promise<Interview[]> {
  return apiFetch<Interview[]>(`/recruitment/applications/${applicationId}/interviews`);
}

export function getInterview(id: string): Promise<Interview> {
  return apiFetch<Interview>(`/recruitment/interviews/${id}`);
}

export interface SubmitScorecardInput {
  rating: number;
  recommendation: ScorecardRecommendation;
  notes?: string;
}

export function submitScorecard(interviewId: string, input: SubmitScorecardInput): Promise<InterviewScorecard> {
  return apiFetch<InterviewScorecard>(`/recruitment/interviews/${interviewId}/scorecards`, { method: 'POST', body: input });
}

export function listScorecards(interviewId: string): Promise<InterviewScorecard[]> {
  return apiFetch<InterviewScorecard[]>(`/recruitment/interviews/${interviewId}/scorecards`);
}

export interface CreateOfferInput {
  applicationId: string;
  branchId: string;
  departmentId?: string;
  designationId?: string;
  employmentType: RecruitmentEmploymentType;
  proposedSalary: number;
  salaryCurrency: string;
  proposedJoinDate: string;
}

export function createOffer(input: CreateOfferInput): Promise<Offer> {
  return apiFetch<Offer>('/recruitment/offers', { method: 'POST', body: input });
}

export function submitOfferForApproval(id: string): Promise<{ submitted: boolean }> {
  return apiFetch(`/recruitment/offers/${id}/submit-for-approval`, { method: 'POST' });
}

export function acceptOffer(id: string): Promise<Offer> {
  return apiFetch<Offer>(`/recruitment/offers/${id}/accept`, { method: 'POST' });
}

export function declineOffer(id: string): Promise<Offer> {
  return apiFetch<Offer>(`/recruitment/offers/${id}/decline`, { method: 'POST' });
}

export function listOffers(params: { applicationId?: string } = {}): Promise<Offer[]> {
  return apiFetch<Offer[]>('/recruitment/offers', { query: params });
}

export function getOffer(id: string): Promise<Offer> {
  return apiFetch<Offer>(`/recruitment/offers/${id}`);
}
