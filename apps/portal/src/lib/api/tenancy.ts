import { apiFetch } from './client';
import type { Branch } from './types';

export function listBranches(): Promise<Branch[]> {
  return apiFetch<Branch[]>('/tenancy/branches');
}
