import {
  educationRank,
  EDUCATION_LEVELS,
  ParsedResume,
  ScreeningCriteriaConfig,
  ScreeningCriterionKey,
  ScreeningCriterionResult,
  ScreeningResult,
} from '@hrm/shared';
import { canonicalSkill, getDefaultSkillDictionary, SkillDictionary } from '../resume-parsing/skills-dictionary';

/**
 * The PURE scoring function — no DB, no I/O — see
 * docs/conventions/resume-parsing-screening.md → Scoring model. Given a
 * candidate's CURRENT parsed data and a requisition's criteria it returns a
 * 0–100 score PLUS a per-criterion breakdown (which skills matched/missed,
 * how many points each criterion contributed) so the number is never a black
 * box. Only criteria the requisition actually configured count: weights are
 * re-normalised across the configured set, so a requisition that only cares
 * about two skills isn't capped at 40/100.
 *
 * It has no notion of stages and no side effects — scoring ASSISTS a human,
 * it can never advance or reject anyone.
 */

function configuredCriteria(config: ScreeningCriteriaConfig): ScreeningCriterionKey[] {
  const keys: ScreeningCriterionKey[] = [];
  if (config.requiredSkills.length > 0) keys.push('requiredSkills');
  if (config.preferredSkills.length > 0) keys.push('preferredSkills');
  if (config.minYearsExperience !== null && config.minYearsExperience !== undefined) keys.push('experience');
  if (config.minEducation && config.minEducation !== 'NONE') keys.push('education');
  if (config.keywordMustHaves.length > 0) keys.push('keywords');
  return keys;
}

/** True when a criteria config declares nothing to score against. */
export function hasScreeningCriteria(config: ScreeningCriteriaConfig): boolean {
  return configuredCriteria(config).length > 0;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const k = v.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  return out;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function highestEducationLevel(parsed: ParsedResume) {
  let best: (typeof EDUCATION_LEVELS)[number] = 'NONE';
  for (const e of parsed.education) if (e.level && educationRank(e.level) > educationRank(best)) best = e.level;
  return best;
}

/** Whole-word, case-insensitive containment (so "java" doesn't match "javascript"). */
function containsKeyword(haystack: string, keyword: string): boolean {
  const body = keyword.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'i').test(haystack);
}

export function scoreResume(params: {
  parsed: ParsedResume;
  config: ScreeningCriteriaConfig;
  basedOnEditedData: boolean;
  dictionary?: SkillDictionary;
  now?: Date;
}): ScreeningResult | null {
  const { parsed, config, basedOnEditedData } = params;
  const dictionary = params.dictionary ?? getDefaultSkillDictionary();
  const keys = configuredCriteria(config);
  if (keys.length === 0) return null;

  const weightSum = keys.reduce((sum, k) => sum + config.weights[k], 0);
  const effectiveWeight = (k: ScreeningCriterionKey): number => (weightSum > 0 ? (config.weights[k] / weightSum) * 100 : 100 / keys.length);

  const candidateSkills = new Set(parsed.skills.map((s) => canonicalSkill(s, dictionary).toLowerCase()));
  const criteria: ScreeningCriterionResult[] = [];

  const skillCriterion = (key: 'requiredSkills' | 'preferredSkills', wanted: string[]) => {
    const list = dedupe(wanted.map((s) => canonicalSkill(s, dictionary)));
    const matched = list.filter((s) => candidateSkills.has(s.toLowerCase()));
    const missed = list.filter((s) => !candidateSkills.has(s.toLowerCase()));
    const fraction = matched.length / list.length;
    const max = effectiveWeight(key);
    criteria.push({
      key,
      status: missed.length === 0 ? 'MET' : matched.length === 0 ? 'MISSED' : 'PARTIAL',
      maxPoints: round1(max),
      earnedPoints: round1(max * fraction),
      matched,
      missed,
      detail: `${matched.length} of ${list.length} ${key === 'requiredSkills' ? 'required' : 'preferred'} skills found`,
      actual: matched.length,
      required: list.length,
    });
  };

  if (keys.includes('requiredSkills')) skillCriterion('requiredSkills', config.requiredSkills);
  if (keys.includes('preferredSkills')) skillCriterion('preferredSkills', config.preferredSkills);

  if (keys.includes('experience')) {
    const required = config.minYearsExperience ?? 0;
    const actual = parsed.totalYearsExperience ?? null;
    const fraction = required <= 0 ? 1 : Math.min(1, (actual ?? 0) / required);
    const max = effectiveWeight('experience');
    criteria.push({
      key: 'experience',
      status: fraction >= 1 ? 'MET' : fraction > 0 ? 'PARTIAL' : 'MISSED',
      maxPoints: round1(max),
      earnedPoints: round1(max * fraction),
      matched: fraction >= 1 ? [`${actual ?? 0} yrs`] : [],
      missed: fraction >= 1 ? [] : [`${required} yrs required`],
      detail: actual === null ? `No experience detected vs ${required} yrs required` : `${actual} yrs vs ${required} yrs required`,
      actual,
      required,
    });
  }

  if (keys.includes('education')) {
    const required = config.minEducation!;
    const actual = highestEducationLevel(parsed);
    const met = educationRank(actual) >= educationRank(required);
    const max = effectiveWeight('education');
    criteria.push({
      key: 'education',
      status: met ? 'MET' : 'MISSED',
      maxPoints: round1(max),
      earnedPoints: met ? round1(max) : 0,
      matched: met ? [actual] : [],
      missed: met ? [] : [required],
      detail: `Highest detected: ${actual} vs minimum ${required}`,
      actual,
      required,
    });
  }

  if (keys.includes('keywords')) {
    const list = dedupe(config.keywordMustHaves.map((k) => k.trim()));
    const text = [parsed.rawText ?? '', parsed.summary ?? '', ...parsed.skills, ...parsed.experience.map((e) => `${e.title ?? ''} ${e.company ?? ''} ${e.description ?? ''}`)].join('\n');
    const matched = list.filter((k) => containsKeyword(text, k));
    const missed = list.filter((k) => !matched.includes(k));
    const max = effectiveWeight('keywords');
    criteria.push({
      key: 'keywords',
      status: missed.length === 0 ? 'MET' : matched.length === 0 ? 'MISSED' : 'PARTIAL',
      maxPoints: round1(max),
      earnedPoints: round1(max * (matched.length / list.length)),
      matched,
      missed,
      detail: `${matched.length} of ${list.length} keywords found in the resume`,
      actual: matched.length,
      required: list.length,
    });
  }

  const earned = criteria.reduce((sum, c) => sum + c.earnedPoints, 0);
  const score = Math.max(0, Math.min(100, Math.round(earned)));
  return {
    score,
    belowThreshold: score < config.belowThresholdScore,
    threshold: config.belowThresholdScore,
    criteria,
    basedOnEditedData,
    computedAt: (params.now ?? new Date()).toISOString(),
  };
}
