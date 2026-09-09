import { BadRequestException, Body, Controller, Get, Param, Post, Req, StreamableFile } from '@nestjs/common';
import type { Request } from 'express';
import { declineSignatureSchema, DeclineSignatureInput, signDocumentSchema, SignDocumentInput } from '@hrm/shared';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AllowAnonymous } from '../auth/decorators/allow-anonymous.decorator';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { SigningService } from './signing.service';

function requireTenantId(tenantId: string | null): string {
  if (!tenantId) {
    throw new BadRequestException('No tenant context is bound to this request.');
  }
  return tenantId;
}

/**
 * The PUBLIC, token-scoped external signing surface — see
 * docs/conventions/e-signatures.md → External signing links. `@AllowAnonymous()`
 * throughout, the SAME "public but tenant-required" pattern the 2.3
 * careers API already establishes (see careers.controller.ts /
 * docs/conventions/recruitment-lifecycle.md): tenant resolution (Host
 * header / `x-tenant-id`) and the request's RLS-scoped transaction still
 * apply exactly as they do for every other route — a candidate/external
 * signer just never presents a JWT. This is deliberately NOT `@Public()`.
 *
 * The path token itself is the ONLY authorization this controller ever
 * checks — `SigningService.resolveExternal` looks it up strictly within
 * the CURRENT request's tenant-scoped transaction, so a token minted under
 * tenant A is structurally invisible to a request resolved under tenant
 * B's Host header (RLS itself enforces this — the SAME isolation guarantee
 * proven for every other tenant-scoped table), and it grants access to
 * exactly the ONE `SignatureSigner` row it names, nothing else in the
 * tenant.
 */
@Controller('e-signatures/sign')
export class ExternalSigningController {
  constructor(
    private readonly signing: SigningService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get(':token')
  @AllowAnonymous()
  async view(@Param('token') token: string) {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    const tx = this.tenantContext.getTx();
    const signer = await this.signing.resolveExternal(tx, tenantId, token);
    const request = await tx.signatureRequest.findUniqueOrThrow({ where: { tenantId_id: { tenantId, id: signer.signatureRequestId } } });
    return {
      signerId: signer.id,
      status: signer.status,
      requestTitle: request.title,
      documentMimeType: request.documentMimeType,
    };
  }

  @Get(':token/document')
  @AllowAnonymous()
  async downloadDocument(@Param('token') token: string): Promise<StreamableFile> {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    const tx = this.tenantContext.getTx();
    const signer = await this.signing.resolveExternal(tx, tenantId, token);
    const { object, mimeType } = await this.signing.view(tx, tenantId, signer);
    return new StreamableFile(object.body, { type: mimeType ?? object.contentType });
  }

  @Post(':token')
  @AllowAnonymous()
  async sign(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(signDocumentSchema)) body: SignDocumentInput,
    @Req() req: Request,
  ) {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    const tx = this.tenantContext.getTx();
    const signer = await this.signing.resolveExternal(tx, tenantId, token);
    return this.signing.sign(tx, tenantId, signer, body, {
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @Post(':token/decline')
  @AllowAnonymous()
  async decline(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(declineSignatureSchema)) body: DeclineSignatureInput,
    @Req() req: Request,
  ) {
    const tenantId = requireTenantId(this.tenantContext.tenantId);
    const tx = this.tenantContext.getTx();
    const signer = await this.signing.resolveExternal(tx, tenantId, token);
    return this.signing.decline(tx, tenantId, signer, body.reason, {
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }
}
