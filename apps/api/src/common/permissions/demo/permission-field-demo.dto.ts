import { PERMISSIONS } from '@hrm/shared';
import { RequiresPermission } from '../requires-permission.decorator';

/**
 * Reference DTO for the field-level permission pattern — see
 * /CLAUDE.md § Conventions → Field-level permissions. `salary` is the
 * task's own canonical example of a field gated behind `salary.view`;
 * `id`/`name`/`department` need no decoration at all to always be included.
 * There is no real Employee/Payroll module yet (later phase) — this DTO
 * exists solely to prove and test the serialization pattern end to end so
 * real modules can copy it exactly when they land.
 */
export class PermissionFieldDemoDto {
  id!: string;
  name!: string;
  department!: string;

  @RequiresPermission(PERMISSIONS.SALARY_VIEW)
  salary!: number;

  constructor(partial: PermissionFieldDemoDto) {
    Object.assign(this, partial);
  }
}
