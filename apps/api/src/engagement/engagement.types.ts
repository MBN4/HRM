/** The authenticated caller, as the engagement services need it. `branchIds` null = unrestricted (no UserBranch rows). */
export interface EngagementActor {
  tenantId: string;
  userId: string;
  branchIds: string[] | null;
  /** Holds `engagement.manage` (sees every feed scope, may moderate). */
  canManage: boolean;
}
