import { BadRequestException, Body, Controller, Get, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { applyToPostingSchema, ApplyToPostingInput } from '@hrm/shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AllowAnonymous } from '../../auth/decorators/allow-anonymous.decorator';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { CareersService } from './careers.service';

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
  async listPostings() {
    return this.careers.listPublished(this.tenantContext.getTx());
  }

  @Get('postings/:slug')
  @AllowAnonymous()
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
