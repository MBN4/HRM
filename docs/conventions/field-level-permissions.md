# Field-level permissions

[← Back to CLAUDE.md](../../CLAUDE.md) · [Build log](../BUILD_LOG.md)

Defined in step 0.4 alongside [auth-rbac.md](./auth-rbac.md) — see
[`docs/BUILD_LOG.md`](../BUILD_LOG.md) (the "0.4 auth + RBAC" entry) for the
full file list and verification notes.

**The reusable, declarative pattern (do not reinvent this per module).** A
decorator ties a response-DTO field to a required permission; a route
interceptor omits ungated fields from nobody, and omits gated fields (not
nulls them) for anyone lacking the permission. Built on `class-transformer`'s
native `groups` feature rather than hand-rolled reflection —
`@Expose({ groups: [permission] })` already implements exactly this
semantic (fields with no `groups` are always included; fields with `groups`
are included only when a matching group is passed):

```ts
// packages/shared: the permission catalog
export const PERMISSIONS = { SALARY_VIEW: 'salary.view', /* ... */ } as const;

// apps/api/src/common/permissions/requires-permission.decorator.ts
export const RequiresPermission = (permission: PermissionKey) =>
  Expose({ groups: [permission] });

// any future module's response DTO
export class EmployeeResponseDto {
  id!: string;
  name!: string;

  @RequiresPermission(PERMISSIONS.SALARY_VIEW)
  salary!: number; // omitted entirely for a caller without salary.view
}

// the route
@Get(':id')
@UseInterceptors(PermissionSerializerInterceptor) // reads TenantContextService's permissions as `groups`
async getEmployee(@Param('id') id: string): Promise<EmployeeResponseDto> {
  return new EmployeeResponseDto(await this.employees.findOne(id)); // must be a real class instance — plain objects have no gating metadata to apply
}
```

`PermissionSerializerInterceptor` (`apps/api/src/common/permissions/permission-serializer.interceptor.ts`)
is what supplies the caller's current permission set as `groups` — apply
it per-route, not globally, since most routes return nothing sensitive
to gate. Reference/test endpoint: `GET /tenancy/permission-field-demo`
(`apps/api/src/common/permissions/demo/`) — there's no real
Employee/Payroll module yet (later phase), so this demo DTO is what
proves and tests the pattern until one exists; copy it exactly, don't
build a parallel mechanism.
