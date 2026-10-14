import type { Candidate } from '@hrm/db';

/**
 * API-facing candidate shape: identical to the row, minus the bulky
 * extracted resume text (`parsedData.rawText`) that exists only so keyword
 * screening can match against it — it is server-owned, never shown in the
 * editor, and would otherwise bloat every candidate list response.
 */
export function toCandidateView(candidate: Candidate): Candidate {
  const parsed = candidate.parsedData;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'rawText' in parsed) {
    const { rawText: _rawText, ...rest } = parsed as Record<string, unknown>;
    return { ...candidate, parsedData: rest as Candidate['parsedData'] };
  }
  return candidate;
}
