import { SetMetadata } from '@nestjs/common';
import { RequestPriority } from '@hrm/shared';

export const PRIORITY_KEY = 'hrm:requestPriority';

/**
 * Classifies a route for `LoadSheddingInterceptor`. Unmarked routes are
 * `NORMAL` (see `@hrm/shared`'s `DEFAULT_REQUEST_PRIORITY`). Mark
 * genuinely critical paths (login, health, core reads) `CRITICAL` — never
 * shed, regardless of load — and genuinely deferrable work (reports, bulk
 * exports, bulk jobs) `LOW` — the first to be shed under pressure.
 */
export const Priority = (priority: RequestPriority) => SetMetadata(PRIORITY_KEY, priority);
