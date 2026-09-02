import { Body, Controller, Get, Param, Post, UseInterceptors } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  createAnnouncementSchema,
  CreateAnnouncementInput,
  createPolicySchema,
  CreatePolicyInput,
  PERMISSIONS,
} from '@hrm/shared';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AuditLog } from '../audit/audit-log.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { AnnouncementService } from './announcement.service';
import { PolicyService } from './policy.service';

/** Announcements & Policies' HTTP surface — see docs/conventions/operations-modules.md. */
@Controller()
export class AnnouncementsController {
  constructor(
    private readonly announcements: AnnouncementService,
    private readonly policies: PolicyService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post('announcements')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ANNOUNCEMENT_MANAGE)
  @AuditLog('Announcement', AUDIT_ACTIONS.CREATE)
  async createAnnouncement(@Body(new ZodValidationPipe(createAnnouncementSchema)) body: CreateAnnouncementInput) {
    return this.announcements.create(this.tenantContext.getTx(), this.tenantContext.tenantId!, this.tenantContext.userId!, body);
  }

  @Post('announcements/:id/publish')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ANNOUNCEMENT_MANAGE)
  @AuditLog('Announcement', AUDIT_ACTIONS.UPDATE)
  async publishAnnouncement(@Param('id') id: string) {
    return this.announcements.publish(this.tenantContext.getTx(), this.tenantContext.tenantId!, id);
  }

  @Post('announcements/:id/deactivate')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.ANNOUNCEMENT_MANAGE)
  @AuditLog('Announcement', AUDIT_ACTIONS.UPDATE)
  async deactivateAnnouncement(@Param('id') id: string) {
    return this.announcements.deactivate(this.tenantContext.getTx(), this.tenantContext.tenantId!, id);
  }

  @Get('announcements/admin')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ANNOUNCEMENT_MANAGE)
  async listAllAnnouncements() {
    return this.announcements.listForAdmin(this.tenantContext.getTx(), this.tenantContext.tenantId!);
  }

  @Get('announcements')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ANNOUNCEMENT_READ)
  async listMyAnnouncements() {
    return this.announcements.listForCaller(this.tenantContext.getTx(), this.tenantContext.tenantId!, this.tenantContext.userId!);
  }

  @Post('policies')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.POLICY_MANAGE)
  @AuditLog('Policy', AUDIT_ACTIONS.CREATE)
  async createPolicy(@Body(new ZodValidationPipe(createPolicySchema)) body: CreatePolicyInput) {
    return this.policies.create(this.tenantContext.getTx(), this.tenantContext.tenantId!, this.tenantContext.userId!, body);
  }

  @Post('policies/:id/publish')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.POLICY_MANAGE)
  @AuditLog('Policy', AUDIT_ACTIONS.UPDATE)
  async publishPolicy(@Param('id') id: string) {
    return this.policies.publish(this.tenantContext.getTx(), this.tenantContext.tenantId!, id);
  }

  @Get('policies/admin')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.POLICY_MANAGE)
  async listAllPolicies() {
    return this.policies.listForAdmin(this.tenantContext.getTx(), this.tenantContext.tenantId!);
  }

  @Get('policies')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.POLICY_READ)
  async listActivePolicies() {
    return this.policies.listActive(this.tenantContext.getTx(), this.tenantContext.tenantId!);
  }

  @Post('policies/:id/acknowledge')
  @UseInterceptors(PermissionsGuard, AuditInterceptor)
  @RequirePermissions(PERMISSIONS.POLICY_READ)
  @AuditLog('PolicyAcknowledgment', AUDIT_ACTIONS.CREATE)
  async acknowledge(@Param('id') id: string) {
    return this.policies.acknowledge(this.tenantContext.getTx(), this.tenantContext.tenantId!, id, this.tenantContext.userId!);
  }

  @Get('policies/:id/acknowledgments')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.POLICY_MANAGE)
  async listAcknowledgments(@Param('id') id: string) {
    return this.policies.listAcknowledgments(this.tenantContext.getTx(), this.tenantContext.tenantId!, id);
  }

  @Get('policies/my-acknowledgments')
  @UseInterceptors(PermissionsGuard)
  @RequirePermissions(PERMISSIONS.POLICY_READ)
  async myAcknowledgments() {
    return this.policies.myAcknowledgments(this.tenantContext.getTx(), this.tenantContext.tenantId!, this.tenantContext.userId!);
  }
}
