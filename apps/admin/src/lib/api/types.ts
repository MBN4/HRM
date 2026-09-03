/**
 * Response shapes for the platform API, hand-mirrored from
 * `apps/api/src/platform/**` rather than imported from `@hrm/shared` — the
 * SAME established duplication convention `apps/portal/src/lib/api/types.ts`
 * documents for itself (packages/shared stays framework-agnostic DTOs/
 * validators, not full response-shape types).
 */

export type PlatformRole = 'PLATFORM_OWNER' | 'PLATFORM_SUPPORT';
export type PlatformAdminStatus = 'ACTIVE' | 'SUSPENDED';
export type TenantStatus = 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'CANCELLED';
export type TenantEdition = 'STARTER' | 'PROFESSIONAL' | 'ENTERPRISE';
export type ProvisionMode = 'SHARED_DB' | 'DB_PER_TENANT';

export interface PlatformLoginStepResult {
  mfaSetupRequired?: true;
  enrollmentToken?: string;
  mfaRequired?: true;
  challengeToken?: string;
}

export interface PlatformSession {
  accessToken: string;
  refreshToken: string;
  platformAdminId: string;
  role: PlatformRole;
  name: string;
  email: string;
}

export interface PlatformEnrollmentSecret {
  secret: string;
  otpauthUrl: string;
}

export interface PlatformMe {
  platformAdminId: string;
  role: PlatformRole;
}

export interface PlatformAdminSummary {
  id: string;
  email: string;
  name: string;
  role: PlatformRole;
  status: PlatformAdminStatus;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  edition: TenantEdition;
  provisionMode: ProvisionMode;
  hostingRegion: string;
  defaultCountryCode: string;
  baseCurrencyCode: string;
  createdAt: string;
  subscription: { edition: TenantEdition; status: string; seatCap: number | null } | null;
  activeLicense: { edition: TenantEdition; seatCap: number; expiresAt: string | null } | null;
}

export interface TenantUsageMetrics {
  tenantId: string;
  seats: { activeEmployees: number; licensedSeatCap: number | null; overCap: boolean };
  storage: { documentCount: number; totalBytes: number };
  apiVolume: { currentWindowCount: number; currentWindowLimit: number; windowSeconds: number };
}

export interface PlatformOverview {
  totalTenants: number;
  byStatus: Record<string, number>;
  byEdition: Record<string, number>;
  totalActiveEmployees: number;
  totalPlatformAdmins: number;
}

export interface CountryPackVersionSummary {
  id: string;
  countryCode: string;
  version: number;
  isActive: boolean;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CountryPackListEntry {
  countryCode: string;
  versions: CountryPackVersionSummary[];
}

export interface ImpersonationSessionDto {
  id: string;
  tenantId: string;
  targetUserId: string;
  platformAdminId: string;
  reason: string;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endedReason: string | null;
}

export interface TenantUserOption {
  id: string;
  email: string;
  status: string;
}

export interface PlatformAuditLogEntry {
  id: string;
  occurredAt: string;
  platformAdminId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  targetTenantId: string | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
}

export interface TenantAuditLogEntry {
  id: string;
  occurredAt: string;
  actorUserId: string | null;
  actorPlatform: boolean;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
}
