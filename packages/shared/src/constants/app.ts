export const APP_NAME = 'hrm' as const;

export const TENANT_HEADER = 'x-tenant-id' as const;

export const SUPPORTED_LICENSE_MODES = ['saas', 'on-prem'] as const;
export type LicenseMode = (typeof SUPPORTED_LICENSE_MODES)[number];
