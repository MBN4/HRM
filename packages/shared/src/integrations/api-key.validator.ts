import { z } from 'zod';
import { ALL_PERMISSIONS } from '../constants/permissions';

/**
 * Public API key DTOs — step 3.3. `scopes` reuses the SAME `PermissionKey`
 * catalog RBAC already uses (`packages/shared`'s `PERMISSIONS`), not a
 * second, parallel scope vocabulary — a key's scopes are literally the
 * permission set `PermissionsGuard` will check against
 * `TenantContextService.getPermissions()` for that request, exactly the way
 * a JWT-authenticated user's permissions are checked.
 */
export const createApiKeySchema = z.object({
  name: z.string().min(1).max(200),
  scopes: z.array(z.enum(ALL_PERMISSIONS as [string, ...string[]])).min(1),
  expiresAt: z.string().datetime().optional(),
  rateLimitPerMinute: z.number().int().positive().max(100000).optional(),
});
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
