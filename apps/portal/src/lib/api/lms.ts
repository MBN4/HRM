import { apiFetch, apiFetchBlob } from './client';
import { triggerBrowserDownload } from '../download';
import type {
  Certification,
  ComplianceDashboardResult,
  ComplianceGapRow,
  Course,
  CourseCategory,
  CourseContentItem,
  CourseWithContent,
  Enrollment,
  Quiz,
  QuizAttempt,
  QuizQuestion,
  RequiredTraining,
  TrainingCalendarEntry,
} from './types';

export interface CreateCourseCategoryInput {
  code: string;
  name: string;
}

export function upsertCourseCategory(input: CreateCourseCategoryInput): Promise<CourseCategory> {
  return apiFetch<CourseCategory>('/lms/categories', { method: 'POST', body: input });
}

export function listCourseCategories(): Promise<CourseCategory[]> {
  return apiFetch<CourseCategory[]>('/lms/categories');
}

export interface CreateCourseInput {
  categoryId?: string;
  title: string;
  description?: string;
  isMandatory?: boolean;
  validityMonths?: number;
}

export function createCourse(input: CreateCourseInput): Promise<Course> {
  return apiFetch<Course>('/lms/courses', { method: 'POST', body: input });
}

export function updateCourse(id: string, input: Partial<CreateCourseInput>): Promise<Course> {
  return apiFetch<Course>(`/lms/courses/${id}`, { method: 'PUT', body: input });
}

export function listCourses(params: { status?: string; categoryId?: string } = {}): Promise<Course[]> {
  return apiFetch<Course[]>('/lms/courses', { query: params });
}

export function getCourse(id: string): Promise<CourseWithContent> {
  return apiFetch<CourseWithContent>(`/lms/courses/${id}`);
}

export function publishCourse(id: string): Promise<Course> {
  return apiFetch<Course>(`/lms/courses/${id}/publish`, { method: 'POST' });
}

export function archiveCourse(id: string): Promise<Course> {
  return apiFetch<Course>(`/lms/courses/${id}/archive`, { method: 'POST' });
}

export interface CreateContentItemInput {
  moduleName?: string;
  orderIndex: number;
  type: 'VIDEO' | 'DOCUMENT' | 'LINK';
  title: string;
  externalUrl?: string;
  durationMinutes?: number;
}

export function addContentItem(courseId: string, input: CreateContentItemInput): Promise<CourseContentItem> {
  return apiFetch<CourseContentItem>(`/lms/courses/${courseId}/content`, { method: 'POST', body: input });
}

export async function uploadContentFile(courseId: string, itemId: string, file: File): Promise<CourseContentItem> {
  const formData = new FormData();
  formData.append('file', file);
  return apiFetch<CourseContentItem>(`/lms/courses/${courseId}/content/${itemId}/file`, { method: 'POST', body: formData });
}

export async function downloadContentFile(courseId: string, itemId: string, filename: string): Promise<void> {
  const { blob } = await apiFetchBlob(`/lms/courses/${courseId}/content/${itemId}/file`);
  triggerBrowserDownload(blob, filename);
}

export function removeContentItem(courseId: string, itemId: string): Promise<{ removed: boolean }> {
  return apiFetch<{ removed: boolean }>(`/lms/courses/${courseId}/content/${itemId}`, { method: 'DELETE' });
}

export interface UpsertQuizInput {
  title: string;
  passMarkPercent?: number;
  isRequired?: boolean;
}

export function upsertQuiz(courseId: string, input: UpsertQuizInput): Promise<Quiz> {
  return apiFetch<Quiz>(`/lms/courses/${courseId}/quiz`, { method: 'PUT', body: input });
}

export interface CreateQuizQuestionInput {
  orderIndex: number;
  questionText: string;
  options: { key: string; text: string }[];
  correctOptionKey: string;
  points?: number;
}

export function addQuizQuestion(courseId: string, input: CreateQuizQuestionInput): Promise<QuizQuestion> {
  return apiFetch<QuizQuestion>(`/lms/courses/${courseId}/quiz/questions`, { method: 'POST', body: input });
}

export function getQuizForTaking(courseId: string): Promise<(Quiz & { questions: QuizQuestion[] }) | null> {
  return apiFetch<(Quiz & { questions: QuizQuestion[] }) | null>(`/lms/courses/${courseId}/quiz`);
}

export function getQuizForAdmin(courseId: string): Promise<(Quiz & { questions: QuizQuestion[] }) | null> {
  return apiFetch<(Quiz & { questions: QuizQuestion[] }) | null>(`/lms/courses/${courseId}/quiz/admin`);
}

export function enrollInCourse(courseId: string): Promise<Enrollment> {
  return apiFetch<Enrollment>(`/lms/courses/${courseId}/enroll`, { method: 'POST' });
}

export function assignCourse(courseId: string, input: { employeeId: string; dueDate?: string }): Promise<Enrollment> {
  return apiFetch<Enrollment>(`/lms/courses/${courseId}/assign`, { method: 'POST', body: input });
}

export function listMyEnrollments(): Promise<Enrollment[]> {
  return apiFetch<Enrollment[]>('/lms/enrollments/me');
}

export function listEnrollments(params: { employeeId?: string; courseId?: string; status?: string; branchId?: string } = {}): Promise<Enrollment[]> {
  return apiFetch<Enrollment[]>('/lms/enrollments', { query: params });
}

export function getEnrollment(id: string): Promise<Enrollment> {
  return apiFetch<Enrollment>(`/lms/enrollments/${id}`);
}

export function markContentComplete(enrollmentId: string, contentItemId: string): Promise<Enrollment> {
  return apiFetch<Enrollment>(`/lms/enrollments/${enrollmentId}/content/${contentItemId}/complete`, { method: 'POST' });
}

export function submitQuizAttempt(enrollmentId: string, answers: Record<string, string>): Promise<QuizAttempt> {
  return apiFetch<QuizAttempt>(`/lms/enrollments/${enrollmentId}/quiz/attempts`, { method: 'POST', body: { answers } });
}

export function listQuizAttempts(enrollmentId: string): Promise<QuizAttempt[]> {
  return apiFetch<QuizAttempt[]>(`/lms/enrollments/${enrollmentId}/quiz/attempts`);
}

export function listMyCertifications(): Promise<Certification[]> {
  return apiFetch<Certification[]>('/lms/certifications/me');
}

export function listCertifications(params: { employeeId?: string; courseId?: string; status?: string } = {}): Promise<Certification[]> {
  return apiFetch<Certification[]>('/lms/certifications', { query: params });
}

export function createRequiredTraining(input: { courseId: string; roleId?: string; branchId?: string }): Promise<RequiredTraining> {
  return apiFetch<RequiredTraining>('/lms/required-trainings', { method: 'POST', body: input });
}

export function listRequiredTrainings(params: { courseId?: string } = {}): Promise<RequiredTraining[]> {
  return apiFetch<RequiredTraining[]>('/lms/required-trainings', { query: params });
}

export function deactivateRequiredTraining(id: string): Promise<RequiredTraining> {
  return apiFetch<RequiredTraining>(`/lms/required-trainings/${id}`, { method: 'DELETE' });
}

export function listComplianceGaps(params: { branchId: string; courseId?: string }): Promise<ComplianceGapRow[]> {
  return apiFetch<ComplianceGapRow[]>('/lms/compliance/gaps', { query: params });
}

export function getComplianceDashboard(params: { branchId?: string; courseId?: string; to?: string } = {}): Promise<ComplianceDashboardResult> {
  return apiFetch<ComplianceDashboardResult>('/lms/compliance/dashboard', { query: params });
}

export function getTrainingCalendar(params: { from?: string; to?: string; branchId?: string } = {}): Promise<TrainingCalendarEntry[]> {
  return apiFetch<TrainingCalendarEntry[]>('/lms/calendar', { query: params });
}

export function runLmsRollup(date?: string): Promise<{ enqueued: boolean }> {
  return apiFetch<{ enqueued: boolean }>('/lms/rollup/run', { method: 'POST', body: { date } });
}
