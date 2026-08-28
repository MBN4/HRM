import { apiFetch } from './client';
import type { EffectiveCountryPackConfig } from './types';

export function getEffectiveCountryPack(branchId: string): Promise<EffectiveCountryPackConfig> {
  return apiFetch<EffectiveCountryPackConfig>('/country-packs/effective', { query: { branchId } });
}
