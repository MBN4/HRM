import { parsedResumeSchema, screeningCriteriaConfigSchema, ParsedResume } from '@hrm/shared';
import { scoreResume } from './screening-scorer.util';

const resume = (over: Partial<ParsedResume>): ParsedResume => parsedResumeSchema.parse({ skills: [], experience: [], education: [], links: [], ...over });
const config = (over: Record<string, unknown>) => screeningCriteriaConfigSchema.parse(over);

describe('scoreResume', () => {
  it('returns null when no criteria are configured', () => {
    expect(scoreResume({ parsed: resume({}), config: config({}), basedOnEditedData: false })).toBeNull();
  });

  it('scores 100 for a full match and reports every criterion as MET', () => {
    const r = scoreResume({
      parsed: resume({ skills: ['TypeScript', 'NestJS', 'Docker'], totalYearsExperience: 6, education: [{ level: 'BACHELOR' }], rawText: 'Led a payments platform' }),
      config: config({ requiredSkills: ['typescript', 'nest.js'], preferredSkills: ['docker'], minYearsExperience: 5, minEducation: 'BACHELOR', keywordMustHaves: ['payments'] }),
      basedOnEditedData: false,
    })!;
    expect(r.score).toBe(100);
    expect(r.criteria.every((c) => c.status === 'MET')).toBe(true);
    expect(r.belowThreshold).toBe(false);
  });

  it('gives partial credit and names matched vs missed skills (aliases canonicalised)', () => {
    const r = scoreResume({ parsed: resume({ skills: ['JavaScript'] }), config: config({ requiredSkills: ['js', 'Python'] }), basedOnEditedData: false })!;
    const c = r.criteria[0];
    expect(c.matched).toEqual(['JavaScript']);
    expect(c.missed).toEqual(['Python']);
    expect(c.status).toBe('PARTIAL');
    expect(r.score).toBe(50); // only one criterion configured → it carries all 100 points
  });

  it('prorates experience and flags below-threshold without any stage side effect', () => {
    const r = scoreResume({ parsed: resume({ totalYearsExperience: 2 }), config: config({ minYearsExperience: 4, belowThresholdScore: 60 }), basedOnEditedData: true })!;
    expect(r.score).toBe(50);
    expect(r.belowThreshold).toBe(true);
    expect(r.basedOnEditedData).toBe(true);
  });

  it('treats education as binary and keyword matches as whole words', () => {
    const r = scoreResume({
      parsed: resume({ education: [{ level: 'DIPLOMA' }], rawText: 'javascript developer' }),
      config: config({ minEducation: 'BACHELOR', keywordMustHaves: ['java'] }),
      basedOnEditedData: false,
    })!;
    expect(r.criteria.find((c) => c.key === 'education')!.status).toBe('MISSED');
    expect(r.criteria.find((c) => c.key === 'keywords')!.status).toBe('MISSED');
    expect(r.score).toBe(0);
  });
});
