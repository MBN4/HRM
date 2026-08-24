import type { Prisma, PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, SYSTEM_ROLE_PERMISSIONS, SYSTEM_ROLES } from '@hrm/shared';

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * Creates the default permission catalog and the four system roles
 * (TENANT_ADMIN/HR_MANAGER/MANAGER/EMPLOYEE) for one tenant, wiring up each
 * role's default permission set from `SYSTEM_ROLE_PERMISSIONS`.
 *
 * Idempotent (safe to call more than once for the same tenant — e.g. a
 * re-run of `prisma/seed.ts`): every write is an `upsert`. Once seeded,
 * these rows are ordinary editable data — nothing about this function
 * re-asserts the default set on a later call if a tenant has since edited
 * it, beyond adding back any permission/role that's still missing.
 *
 * Used by `prisma/seed.ts` for the demo tenant today. This is also the
 * function real tenant provisioning (0.6 licensing/onboarding) should call
 * for every new tenant — don't duplicate this logic elsewhere.
 */
export async function seedSystemRolesAndPermissions(client: Client, tenantId: string): Promise<void> {
  const permissionByKey = new Map<string, string>();

  for (const key of ALL_PERMISSIONS) {
    const permission = await client.permission.upsert({
      where: { tenantId_key: { tenantId, key } },
      update: {},
      create: { tenantId, key },
    });
    permissionByKey.set(key, permission.id);
  }

  for (const [roleName, permissionKeys] of Object.entries(SYSTEM_ROLE_PERMISSIONS)) {
    const role = await client.role.upsert({
      where: { tenantId_name: { tenantId, name: roleName } },
      update: {},
      create: { tenantId, name: roleName, isSystem: true },
    });

    for (const key of permissionKeys) {
      const permissionId = permissionByKey.get(key);
      /* istanbul ignore next -- permissionByKey is populated from the same ALL_PERMISSIONS list above */
      if (!permissionId) continue;
      await client.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId } },
        update: {},
        create: { tenantId, roleId: role.id, permissionId },
      });
    }
  }
}

export { SYSTEM_ROLES };
