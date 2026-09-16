import { BadRequestException, Body, Controller, Get, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { applyToPostingSchema, ApplyToPostingInput } from '@hrm/shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AllowAnonymous } from '../../auth/decorators/allow-anonymous.decorator';
import { CacheControlPublic } from '../../security/cache-control.decorator';
import { CacheControlInterceptor } from '../../security/cache-control.interceptor';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { CareersService } from './careers.service';

/**
 * Step 6.3 — 60s at the edge, a 5-minute stale-while-revalidate window: a
 * newly published/closed posting propagates within a minute (short enough
 * that a candidate never waits long for a stale listing), and a visitor
 * during that window still gets an instant cached response while the CDN
 * revalidates in the background rather than forcing a synchronous origin
 * round trip on every cache expiry — see docs/conventions/edge-security.md.
 */
const CAREERS_CACHE_MAX_AGE_SECONDS = 60;
const CAREERS_CACHE_STALE_WHILE_REVALIDATE_SECONDS = 300;

const MAX_RESUME_SIZE_BYTES = 10 * 1024 * 1024;

function requireTenantId(tenantId: string | null): string {
  if (!tenantId) {
    throw new BadRequestException('No tenant context is bound to this request.');
  }
  return tenantId;
}

/**
 * The PUBLIC careers API — see docs/conventions/recruitment-lifecycle.md.
 * `@AllowAnonymous()` throughout: tenant resolution (Host header) and the
 * request's RLS-scoped transaction still apply exactly as they do for
 * every other route — this is NOT `@Public()` — a candidate just never
 * presents a JWT, the SAME "public but tenant-required" pattern
 * `POST /auth/login` already establishes (see docs/conventions/auth-rbac.md).
 * No `@RequirePermissions()` anywhere here: there is no authenticated
 * caller to hold permissions at all.
 */
@Controller('careers')
export class CareersController {
  constructor(
    private readonly careers: CareersService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('postings')
  @AllowAnonymous()
  @UseInterceptors(CacheControlInterceptor)
  @CacheControlPublic(CAREERS_CACHE_MAX_AGE_SECONDS, CAREERS_CACHE_STALE_WHILE_REVALIDATE_SECONDS)
  async listPostings() {
    return this.careers.listPublished(this.tenantContext.getTx());
  }

  @Get('postings/:slug')
  @AllowAnonymous()
  @UseInterceptors(CacheControlInterceptor)
  @CacheControlPublic(CAREERS_CACHE_MAX_AGE_SECONDS, CAREERS_CACHE_STALE_WHILE_REVALIDATE_SECONDS)
  async getPosting(@Param('slug') slug: string) {
    return this.careers.getPublishedBySlug(this.tenantContext.getTx(), slug);
  }

  @Post('postings/:slug/apply')
  @AllowAnonymous()
  @UseInterceptors(FileInterceptor('resume', { limits: { fileSize: MAX_RESUME_SIZE_BYTES } }))
  async apply(
    @Param('slug') slug: string,
    @UploadedFile() resume: Express.Multer.File | undefined,
    @Body(new ZodValidationPipe(applyToPostingSchema)) body: ApplyToPostingInput,
  ) {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    return this.careers.apply(
      this.tenantContext.getTx(),
      tenantId,
      slug,
      body,
      resume ? { buffer: resume.buffer, originalname: resume.originalname, mimetype: resume.mimetype } : undefined,
    );
  }
}
