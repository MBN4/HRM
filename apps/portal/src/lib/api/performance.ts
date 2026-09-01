import { apiFetch } from './client';
import type {
  Appraisal,
  AppraisalCycle,
  AppraisalCycleType,
  AppraisalDetail,
  CalibrationRow,
  Goal,
  GoalLevel,
  GoalStatus,
  RatingLevel,
  RatingScale,
  Review,
  ReviewAssignment,
  ReviewType,
} from './types';

export interface UpsertRatingScaleInput {
  key: string;
  name: string;
  levels: RatingLevel[];
}

export function upsertRatingScale(input: UpsertRatingScaleInput): Promise<RatingScale> {
  return apiFetch<RatingScale>('/performance/rating-scales', { method: 'POST', body: input });
}

export function listRatingScales(): Promise<RatingScale[]> {
  return apiFetch<RatingScale[]>('/performance/rating-scales');
}

export interface CreateAppraisalCycleInput {
  name: string;
  cycleType: AppraisalCycleType;
  startDate: string;
  endDate: string;
  ratingScaleKey: string;
  enabledReviewTypes: ReviewType[];
  eligibleBranchIds: string[];
  eligibleDepartmentIds: string[];
}

export function createAppraisalCycle(input: CreateAppraisalCycleInput): Promise<AppraisalCycle> {
  return apiFetch<AppraisalCycle>('/performance/cycles', { method: 'POST', body: input });
}

export function openAppraisalCycle(id: string): Promise<AppraisalCycle> {
  return apiFetch<AppraisalCycle>(`/performance/cycles/${id}/open`, { method: 'POST' });
}

export function closeAppraisalCycle(id: string): Promise<AppraisalCycle> {
  return apiFetch<AppraisalCycle>(`/performance/cycles/${id}/close`, { method: 'POST' });
}

export function listAppraisalCycles(): Promise<AppraisalCycle[]> {
  return apiFetch<AppraisalCycle[]>('/performance/cycles');
}

export function getAppraisalCycle(id: string): Promise<AppraisalCycle> {
  return apiFetch<AppraisalCycle>(`/performance/cycles/${id}`);
}

export function getCalibration(id: string, params: { branchId?: string } = {}): Promise<CalibrationRow[]> {
  return apiFetch<CalibrationRow[]>(`/performance/cycles/${id}/calibration`, { query: params });
}

export function recomputeCalibration(id: string): Promise<{ enqueued: boolean }> {
  return apiFetch(`/performance/cycles/${id}/calibration/recompute`, { method: 'POST' });
}

export interface CreateGoalInput {
  level: GoalLevel;
  employeeId?: string;
  departmentId?: string;
  parentGoalId?: string;
  cycleId?: string;
  title: string;
  description?: string;
  targetValue?: number;
  unit?: string;
  startDate: string;
  endDate: string;
}

export function createGoal(input: CreateGoalInput): Promise<Goal> {
  return apiFetch<Goal>('/performance/goals', { method: 'POST', body: input });
}

export function listGoals(
  params: { employeeId?: string; departmentId?: string; level?: GoalLevel; cycleId?: string; branchId?: string } = {},
): Promise<Goal[]> {
  return apiFetch<Goal[]>('/performance/goals', { query: params });
}

export interface UpdateGoalProgressInput {
  currentValue?: number;
  progressPercent?: number;
  status?: GoalStatus;
}

export function updateGoalProgress(id: string, input: UpdateGoalProgressInput): Promise<Goal> {
  return apiFetch<Goal>(`/performance/goals/${id}/progress`, { method: 'PATCH', body: input });
}

export function listAppraisals(params: { cycleId?: string; employeeId?: string; status?: string; branchId?: string } = {}): Promise<Appraisal[]> {
  return apiFetch<Appraisal[]>('/performance/appraisals', { query: params });
}

export function getAppraisal(id: string): Promise<AppraisalDetail> {
  return apiFetch<AppraisalDetail>(`/performance/appraisals/${id}`);
}

export function assignPeerReviewers(id: string, input: { reviewerIds: string[] }): Promise<ReviewAssignment[]> {
  return apiFetch<ReviewAssignment[]>(`/performance/appraisals/${id}/peer-assignments`, { method: 'POST', body: input });
}

export function submitAppraisalForApproval(id: string): Promise<{ submitted: boolean }> {
  return apiFetch(`/performance/appraisals/${id}/submit-for-approval`, { method: 'POST' });
}

export function getMyReviewAssignments(): Promise<ReviewAssignment[]> {
  return apiFetch<ReviewAssignment[]>('/performance/my-review-assignments');
}

export interface SubmitReviewInput {
  overallRating: number;
  strengths?: string;
  improvements?: string;
  comments?: string;
}

export function submitReview(assignmentId: string, input: SubmitReviewInput): Promise<Review> {
  return apiFetch<Review>(`/performance/review-assignments/${assignmentId}/submit`, { method: 'POST', body: input });
}
