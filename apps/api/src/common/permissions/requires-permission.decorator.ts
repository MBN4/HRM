import { Expose } from 'class-transformer';
import type { PermissionKey } from '@hrm/shared';

/**
 * Marks a response-DTO field as requiring `permission` to be present in the
 * response at all — not nulled, OMITTED. Built on `class-transformer`'s
 * `@Expose({ groups })`, which already implements exactly this semantic
 * (fields with no `groups` are always included; fields with `groups` are
 * included only when a matching group is passed to the transform call) —
 * `PermissionSerializerInterceptor` is what supplies the current user's
 * permission set as those groups on every response.
 *
 * See /CLAUDE.md § Conventions → Field-level permissions for the full
 * pattern and a usage example — every future module with a sensitive field
 * (salary, national ID, bank details, ...) should reuse this, not
 * reinvent field-gating per module.
 */
export const RequiresPermission = (permission: PermissionKey) => Expose({ groups: [permission] });
