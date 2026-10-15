import { apiFetch } from './client';
import { getOwnEmployee } from './employees';
import type {
  EngagementOverview,
  FeedComment,
  FeedPage,
  FeedPost,
  FeedReactions,
  FeedScope,
  Leaderboard,
  MySurvey,
  ReactionType,
  RecognitionCategory,
  RecognitionProfile,
  RecognitionView,
  RecognitionVisibility,
  SurveyAnswerInput,
  SurveyAudienceType,
  SurveyDetail,
  SurveyForTaking,
  SurveyQuestionType,
  SurveyRespondent,
  SurveyResults,
  SurveySummary,
} from './types';

// ---- Recognition ----

export function listRecognitionCategories(all = false): Promise<RecognitionCategory[]> {
  return apiFetch<RecognitionCategory[]>('/recognition/categories', { query: { all: all ? 'true' : undefined } });
}

export interface RecognitionCategoryInput {
  name: string;
  description?: string;
  points: number;
  isActive: boolean;
}

export function createRecognitionCategory(input: RecognitionCategoryInput): Promise<RecognitionCategory> {
  return apiFetch<RecognitionCategory>('/recognition/categories', { method: 'POST', body: input });
}

export function updateRecognitionCategory(id: string, input: RecognitionCategoryInput): Promise<RecognitionCategory> {
  return apiFetch<RecognitionCategory>(`/recognition/categories/${id}`, { method: 'PUT', body: input });
}

export function giveRecognition(input: { recipientEmployeeIds: string[]; categoryId: string; message: string; visibility: RecognitionVisibility }): Promise<RecognitionView> {
  return apiFetch<RecognitionView>('/recognition', { method: 'POST', body: input });
}

export function listReceivedRecognition(): Promise<RecognitionView[]> {
  return apiFetch<RecognitionView[]>('/recognition/received');
}

export function listGivenRecognition(): Promise<RecognitionView[]> {
  return apiFetch<RecognitionView[]>('/recognition/given');
}

export function getLeaderboard(params: { from?: string; to?: string; categoryId?: string; limit?: number } = {}): Promise<Leaderboard> {
  return apiFetch<Leaderboard>('/recognition/leaderboard', { query: params });
}

export function getRecognitionProfile(employeeId: string): Promise<RecognitionProfile> {
  return apiFetch<RecognitionProfile>(`/recognition/profile/${employeeId}`);
}

/** The caller's own recognition balance (resolve their employee id, then read their self profile). Null when they have no employee profile. */
export async function getOwnRecognitionPoints(): Promise<{ employeeId: string; totalPoints: number } | null> {
  try {
    const me = await getOwnEmployee();
    const profile = await getRecognitionProfile(me.id);
    return { employeeId: me.id, totalPoints: profile.totalPoints };
  } catch {
    return null;
  }
}

// ---- Surveys: employee ----

export function listMySurveys(): Promise<MySurvey[]> {
  return apiFetch<MySurvey[]>('/surveys/mine');
}

export function getSurveyForTaking(id: string): Promise<SurveyForTaking> {
  return apiFetch<SurveyForTaking>(`/surveys/mine/${id}`);
}

export function submitSurveyResponse(id: string, answers: SurveyAnswerInput[]): Promise<unknown> {
  return apiFetch(`/surveys/${id}/responses`, { method: 'POST', body: { answers } });
}

// ---- Surveys: admin ----

export interface SurveyQuestionInputBody {
  type: SurveyQuestionType;
  prompt: string;
  required: boolean;
  scaleMin?: number;
  scaleMax?: number;
  options?: { id: string; label: string }[];
}

export interface SurveyInputBody {
  title: string;
  description?: string;
  anonymous: boolean;
  audienceType: SurveyAudienceType;
  audienceIds: string[];
  opensAt?: string;
  closesAt?: string;
  questions: SurveyQuestionInputBody[];
}

export function listSurveysAdmin(): Promise<SurveySummary[]> {
  return apiFetch<SurveySummary[]>('/surveys');
}

export function createSurvey(input: SurveyInputBody): Promise<SurveyDetail> {
  return apiFetch<SurveyDetail>('/surveys', { method: 'POST', body: input });
}

export function updateSurvey(id: string, input: SurveyInputBody): Promise<SurveyDetail> {
  return apiFetch<SurveyDetail>(`/surveys/${id}`, { method: 'PUT', body: input });
}

export function getSurveyAdmin(id: string): Promise<SurveyDetail> {
  return apiFetch<SurveyDetail>(`/surveys/${id}`);
}

export function publishSurvey(id: string): Promise<SurveyDetail> {
  return apiFetch<SurveyDetail>(`/surveys/${id}/publish`, { method: 'POST' });
}

export function closeSurvey(id: string): Promise<SurveyDetail> {
  return apiFetch<SurveyDetail>(`/surveys/${id}/close`, { method: 'POST' });
}

export function getSurveyResults(id: string): Promise<SurveyResults> {
  return apiFetch<SurveyResults>(`/surveys/${id}/results`);
}

export function listSurveyRespondents(id: string): Promise<SurveyRespondent[]> {
  return apiFetch<SurveyRespondent[]>(`/surveys/${id}/respondents`);
}

// ---- Feed ----

export function getFeed(params: { scope?: FeedScope; before?: string; limit?: number } = {}): Promise<FeedPage> {
  return apiFetch<FeedPage>('/feed', { query: params });
}

export interface FeedPostInput {
  type: 'ANNOUNCEMENT' | 'CELEBRATION';
  title?: string;
  body: string;
  scopeType: 'ORG' | 'BRANCH' | 'DEPARTMENT';
  scopeId?: string;
  pinned: boolean;
}

export function createFeedPost(input: FeedPostInput): Promise<FeedPost> {
  return apiFetch<FeedPost>('/feed/posts', { method: 'POST', body: input });
}

export function removeFeedPost(id: string, reason?: string): Promise<{ id: string; removed: boolean }> {
  return apiFetch(`/feed/posts/${id}`, { method: 'DELETE', query: { reason } });
}

export function reactToPost(id: string, type: ReactionType): Promise<FeedReactions> {
  return apiFetch<FeedReactions>(`/feed/posts/${id}/reactions`, { method: 'POST', body: { type } });
}

export function unreactToPost(id: string): Promise<FeedReactions> {
  return apiFetch<FeedReactions>(`/feed/posts/${id}/reactions`, { method: 'DELETE' });
}

export function listFeedComments(id: string): Promise<FeedComment[]> {
  return apiFetch<FeedComment[]>(`/feed/posts/${id}/comments`);
}

export function addFeedComment(id: string, body: string): Promise<FeedComment> {
  return apiFetch<FeedComment>(`/feed/posts/${id}/comments`, { method: 'POST', body: { body } });
}

export function removeFeedComment(id: string): Promise<{ id: string; removed: boolean }> {
  return apiFetch(`/feed/comments/${id}`, { method: 'DELETE' });
}

export function generateCelebrations(): Promise<{ created: number }> {
  return apiFetch<{ created: number }>('/feed/celebrations/generate', { method: 'POST' });
}

// ---- Overview ----

export function getEngagementOverview(params: { from?: string; to?: string } = {}): Promise<EngagementOverview> {
  return apiFetch<EngagementOverview>('/engagement/overview', { query: params });
}
