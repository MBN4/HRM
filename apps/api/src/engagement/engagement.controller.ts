import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, UseInterceptors } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  createFeedCommentSchema,
  CreateFeedCommentInput,
  createFeedPostSchema,
  CreateFeedPostInput,
  createSurveySchema,
  CreateSurveyInput,
  feedQuerySchema,
  FeedQuery,
  giveRecognitionSchema,
  GiveRecognitionInput,
  leaderboardQuerySchema,
  LeaderboardQuery,
  moderationSchema,
  overviewQuerySchema,
  OverviewQuery,
  PERMISSIONS,
  reactSchema,
  ReactInput,
  submitSurveyResponseSchema,
  SubmitSurveyResponseInput,
  upsertRecognitionCategorySchema,
  UpsertRecognitionCategoryInput,
} from '@hrm/shared';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AuditLog } from '../audit/audit-log.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { CelebrationsService } from './celebrations.service';
import { EngagementOverviewService } from './engagement-overview.service';
import { FeedService } from './feed.service';
import { RecognitionCategoryService } from './recognition-category.service';
import { RecognitionService } from './recognition.service';
import { SurveyResponseService } from './survey-response.service';
import { SurveyResultsService } from './survey-results.service';
import { SurveyService } from './survey.service';
import { parseDate } from './engagement-people.util';
import type { EngagementActor } from './engagement.types';

/**
 * Engagement & culture's HTTP surface (step 10.1) — recognition, surveys, the feed. See
 * docs/conventions/engagement-culture.md. Three RBAC tiers:
 *   - `engagement.manage` — categories, survey authoring/results, announcements, moderation, overview;
 *   - `recognition.give`  — the broad participation permission: give recognition, react, comment;
 *   - authentication only — reading the feed, answering a survey assigned to you, viewing recognition
 *     (inherently self-scoped, the same posture as `/notifications`).
 */
@Controller()
export class EngagementController {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly categories: RecognitionCategoryService,
    private readonly recognition: RecognitionService,
    private readonly surveys: SurveyService,
    private readonly responses: SurveyResponseService,
    private readonly results: SurveyResultsService,
    private readonly feed: FeedService,
    private readonly celebrations: CelebrationsService,
    private readonly overviewService: EngagementOverviewService,
  ) {}

  private actor(): EngagementActor {
    const ctx = this.tenantContext.getContext();
    return {
      tenantId: ctx.tenantId!,
      userId: ctx.userId!,
      branchIds: ctx.branchIds,
      canManage: (ctx.permissions ?? []).includes(PERMISSIONS.ENGAGEMENT_MANAGE),
    };
  }
  private get tx() {
    return this.tenantContext.getTx();
  }

  // ---- Recognition: categories ----------------------------------------------

  @Get('recognition/categories')
  async listCategories(@Query('all') all?: string) {
    const actor = this.actor();
    return this.categories.list(this.tx, actor.tenantId, actor.canManage && all === 'true');
  }

  @Post('recognition/categories')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ENGAGEMENT_MANAGE)
  @AuditLog('RecognitionCategory', AUDIT_ACTIONS.CREATE)
  async createCategory(@Body(new ZodValidationPipe(upsertRecognitionCategorySchema)) body: UpsertRecognitionCategoryInput) {
    return this.categories.create(this.tx, this.actor().tenantId, body);
  }

  @Put('recognition/categories/:id')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ENGAGEMENT_MANAGE)
  @AuditLog('RecognitionCategory', AUDIT_ACTIONS.UPDATE)
  async updateCategory(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(upsertRecognitionCategorySchema)) body: UpsertRecognitionCategoryInput) {
    return this.categories.update(this.tx, this.actor().tenantId, id, body);
  }

  // ---- Recognition ------------------------------------------------------------

  @Post('recognition')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.RECOGNITION_GIVE)
  @AuditLog('Recognition', AUDIT_ACTIONS.CREATE)
  async give(@Body(new ZodValidationPipe(giveRecognitionSchema)) body: GiveRecognitionInput) {
    return this.recognition.give(this.tx, this.actor(), body);
  }

  @Get('recognition/received')
  async received() {
    return this.recognition.listReceived(this.tx, this.actor());
  }

  @Get('recognition/given')
  async given() {
    return this.recognition.listGiven(this.tx, this.actor());
  }

  @Get('recognition/leaderboard')
  async leaderboard(@Query(new ZodValidationPipe(leaderboardQuerySchema)) query: LeaderboardQuery) {
    return this.recognition.leaderboard(this.tx, this.actor(), query);
  }

  @Get('recognition/profile/:employeeId')
  async profile(@Param('employeeId', ParseUUIDPipe) employeeId: string) {
    return this.recognition.profile(this.tx, this.actor(), employeeId);
  }

  // ---- Surveys: employee side -------------------------------------------------

  @Get('surveys/mine')
  async mySurveys() {
    const actor = this.actor();
    return this.surveys.listMine(this.tx, actor.tenantId, actor.userId);
  }

  @Get('surveys/mine/:id')
  async takeSurvey(@Param('id', ParseUUIDPipe) id: string) {
    const actor = this.actor();
    return this.surveys.getForTaking(this.tx, actor.tenantId, actor.userId, id);
  }

  /** Deliberately NOT audited — see `SurveyResponseService`'s doc comment (anonymity). */
  @Post('surveys/:id/responses')
  async submit(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(submitSurveyResponseSchema)) body: SubmitSurveyResponseInput) {
    const actor = this.actor();
    return this.responses.submit(this.tx, actor.tenantId, actor.userId, id, body);
  }

  // ---- Surveys: admin side ----------------------------------------------------

  @Get('surveys')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ENGAGEMENT_MANAGE)
  async listSurveys() {
    return this.surveys.listForAdmin(this.tx, this.actor());
  }

  @Post('surveys')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ENGAGEMENT_MANAGE)
  @AuditLog('Survey', AUDIT_ACTIONS.CREATE)
  async createSurvey(@Body(new ZodValidationPipe(createSurveySchema)) body: CreateSurveyInput) {
    return this.surveys.create(this.tx, this.actor(), body);
  }

  @Get('surveys/:id')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ENGAGEMENT_MANAGE)
  async getSurvey(@Param('id', ParseUUIDPipe) id: string) {
    return this.surveys.detail(this.tx, this.actor().tenantId, id);
  }

  @Put('surveys/:id')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ENGAGEMENT_MANAGE)
  @AuditLog('Survey', AUDIT_ACTIONS.UPDATE)
  async updateSurvey(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(createSurveySchema)) body: CreateSurveyInput) {
    return this.surveys.update(this.tx, this.actor(), id, body);
  }

  @Post('surveys/:id/publish')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ENGAGEMENT_MANAGE)
  @AuditLog('Survey', AUDIT_ACTIONS.UPDATE)
  async publishSurvey(@Param('id', ParseUUIDPipe) id: string) {
    return this.surveys.publish(this.tx, this.actor(), id);
  }

  @Post('surveys/:id/close')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ENGAGEMENT_MANAGE)
  @AuditLog('Survey', AUDIT_ACTIONS.UPDATE)
  async closeSurvey(@Param('id', ParseUUIDPipe) id: string) {
    return this.surveys.close(this.tx, this.actor().tenantId, id);
  }

  @Get('surveys/:id/results')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ENGAGEMENT_MANAGE)
  async surveyResults(@Param('id', ParseUUIDPipe) id: string) {
    return this.results.results(this.tx, this.actor().tenantId, id);
  }

  @Get('surveys/:id/respondents')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ENGAGEMENT_MANAGE)
  async surveyRespondents(@Param('id', ParseUUIDPipe) id: string) {
    return this.surveys.respondents(this.tx, this.actor().tenantId, id);
  }

  // ---- Feed -------------------------------------------------------------------

  @Get('feed')
  async listFeed(@Query(new ZodValidationPipe(feedQuerySchema)) query: FeedQuery) {
    return this.feed.list(this.tx, this.actor(), query);
  }

  @Post('feed/posts')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ENGAGEMENT_MANAGE)
  @AuditLog('FeedPost', AUDIT_ACTIONS.CREATE)
  async createPost(@Body(new ZodValidationPipe(createFeedPostSchema)) body: CreateFeedPostInput) {
    return this.feed.createPost(this.tx, this.actor(), body);
  }

  @Delete('feed/posts/:id')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ENGAGEMENT_MANAGE)
  @AuditLog('FeedPost', AUDIT_ACTIONS.DELETE)
  async removePost(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodValidationPipe(moderationSchema)) query: { reason?: string }) {
    return this.feed.removePost(this.tx, this.actor(), id, query.reason);
  }

  @Post('feed/posts/:id/reactions')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.RECOGNITION_GIVE)
  async react(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(reactSchema)) body: ReactInput) {
    return this.feed.react(this.tx, this.actor(), id, body);
  }

  @Delete('feed/posts/:id/reactions')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.RECOGNITION_GIVE)
  async unreact(@Param('id', ParseUUIDPipe) id: string) {
    return this.feed.unreact(this.tx, this.actor(), id);
  }

  @Get('feed/posts/:id/comments')
  async listComments(@Param('id', ParseUUIDPipe) id: string) {
    return this.feed.listComments(this.tx, this.actor(), id);
  }

  @Post('feed/posts/:id/comments')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.RECOGNITION_GIVE)
  async addComment(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(createFeedCommentSchema)) body: CreateFeedCommentInput) {
    return this.feed.addComment(this.tx, this.actor(), id, body);
  }

  @Delete('feed/comments/:id')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ENGAGEMENT_MANAGE)
  @AuditLog('FeedComment', AUDIT_ACTIONS.DELETE)
  async removeComment(@Param('id', ParseUUIDPipe) id: string) {
    return this.feed.removeComment(this.tx, this.actor(), id);
  }

  /** On-demand run of the daily celebrations job for one tenant (idempotent). `date` defaults to today (UTC). */
  @Post('feed/celebrations/generate')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ENGAGEMENT_MANAGE)
  async generateCelebrations(@Query('date') date?: string) {
    const created = await this.celebrations.generate(this.tx, this.actor().tenantId, date ? parseDate(date) : new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z'));
    return { created };
  }

  // ---- Overview ---------------------------------------------------------------

  @Get('engagement/overview')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ENGAGEMENT_MANAGE)
  async overview(@Query(new ZodValidationPipe(overviewQuerySchema)) query: OverviewQuery) {
    return this.overviewService.overview(this.tx, this.actor(), query);
  }
}
