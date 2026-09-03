import { apiFetch } from './client';
import type { CountryPackListEntry, CountryPackVersionSummary } from './types';

export function listCountryPacks(): Promise<CountryPackListEntry[]> {
  return apiFetch('/platform/country-packs');
}

export function listCountryPackVersions(countryCode: string): Promise<CountryPackVersionSummary[]> {
  return apiFetch(`/platform/country-packs/${countryCode}`);
}

export function createCountryPack(countryCode: string, config: unknown): Promise<CountryPackVersionSummary> {
  return apiFetch('/platform/country-packs', { method: 'POST', body: { countryCode, config } });
}

export function createCountryPackVersion(countryCode: string, config?: unknown): Promise<CountryPackVersionSummary> {
  return apiFetch(`/platform/country-packs/${countryCode}/versions`, { method: 'POST', body: config ? { config } : {} });
}

export function updateCountryPackVersion(countryCode: string, version: number, config: unknown): Promise<CountryPackVersionSummary> {
  return apiFetch(`/platform/country-packs/${countryCode}/versions/${version}`, { method: 'PUT', body: { config } });
}

export function activateCountryPackVersion(countryCode: string, version: number): Promise<CountryPackVersionSummary> {
  return apiFetch(`/platform/country-packs/${countryCode}/versions/${version}/activate`, { method: 'POST' });
}
