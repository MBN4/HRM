/**
 * The offboarding clearance checklist's `key` a tenant's `ChecklistTemplate`
 * should use for its "asset return" task so `OffboardingController` can
 * wire it to the REAL asset register — see
 * docs/conventions/operations-modules.md. Any other checklist task key
 * behaves exactly as it always has (a plain, manually-completed task);
 * this is the ONE key this step gives real meaning to.
 */
export const ASSET_RETURN_CHECKLIST_TASK_KEY = 'asset_return';
