import { existsSync, readFileSync } from 'fs';

/**
 * The default parser's CONFIGURABLE skills dictionary — see
 * docs/conventions/resume-parsing-screening.md. `name` is the canonical
 * spelling stored on a candidate and compared by the screening scorer;
 * `aliases` are other spellings that normalise to it ("JS" → JavaScript), so
 * a criteria skill typed "js" still matches a resume that says "JavaScript".
 * `ambiguous` entries are common English words/letters ("Go", "R") that only
 * match case-exactly inside a Skills section, to avoid "go to market" noise.
 *
 * Extend without a code change: point `RESUME_SKILLS_DICTIONARY_PATH` at a
 * JSON array of the same entry shape; its entries are merged over (and win
 * against) the built-in list by canonical name.
 */
export interface SkillEntry {
  name: string;
  aliases?: string[];
  ambiguous?: boolean;
}

export const DEFAULT_SKILLS: SkillEntry[] = [
  // Languages
  { name: 'JavaScript', aliases: ['js', 'ecmascript', 'es6'] },
  { name: 'TypeScript', aliases: ['ts'] },
  { name: 'Python' },
  { name: 'Java' },
  { name: 'C#', aliases: ['c sharp', 'csharp'] },
  { name: 'C++', aliases: ['cpp'] },
  { name: 'Go', aliases: ['golang'], ambiguous: true },
  { name: 'Rust', ambiguous: true },
  { name: 'Ruby' },
  { name: 'PHP' },
  { name: 'Swift', ambiguous: true },
  { name: 'Kotlin' },
  { name: 'Scala' },
  { name: 'R', ambiguous: true },
  { name: 'SQL' },
  { name: 'Bash', aliases: ['shell scripting'] },
  { name: 'HTML', aliases: ['html5'] },
  { name: 'CSS', aliases: ['css3'] },
  // Frontend
  { name: 'React', aliases: ['react.js', 'reactjs'] },
  { name: 'Next.js', aliases: ['nextjs'] },
  { name: 'Angular', aliases: ['angularjs'] },
  { name: 'Vue', aliases: ['vue.js', 'vuejs'] },
  { name: 'Redux' },
  { name: 'Tailwind CSS', aliases: ['tailwind'] },
  { name: 'React Native' },
  { name: 'Flutter' },
  // Backend
  { name: 'Node.js', aliases: ['node', 'nodejs'] },
  { name: 'NestJS', aliases: ['nest.js'] },
  { name: 'Express', aliases: ['express.js', 'expressjs'] },
  { name: 'Django' },
  { name: 'Flask' },
  { name: 'FastAPI' },
  { name: 'Spring Boot', aliases: ['spring'] },
  { name: '.NET', aliases: ['dotnet', '.net core', 'asp.net'] },
  { name: 'Laravel' },
  { name: 'Ruby on Rails', aliases: ['rails'] },
  { name: 'GraphQL' },
  { name: 'REST', aliases: ['rest api', 'restful', 'restful api', 'restful apis', 'rest apis'] },
  { name: 'Microservices' },
  // Data
  { name: 'PostgreSQL', aliases: ['postgres'] },
  { name: 'MySQL' },
  { name: 'MongoDB', aliases: ['mongo'] },
  { name: 'Redis' },
  { name: 'Elasticsearch' },
  { name: 'Kafka' },
  { name: 'RabbitMQ' },
  { name: 'Prisma' },
  { name: 'Pandas' },
  { name: 'NumPy' },
  { name: 'Machine Learning', aliases: ['ml'] },
  { name: 'Deep Learning' },
  { name: 'TensorFlow' },
  { name: 'PyTorch' },
  { name: 'Data Analysis', aliases: ['data analytics'] },
  { name: 'Power BI', aliases: ['powerbi'] },
  { name: 'Tableau' },
  { name: 'Excel', aliases: ['microsoft excel', 'ms excel'], ambiguous: false },
  // DevOps / cloud
  { name: 'AWS', aliases: ['amazon web services'] },
  { name: 'Azure', aliases: ['microsoft azure'] },
  { name: 'GCP', aliases: ['google cloud', 'google cloud platform'] },
  { name: 'Docker' },
  { name: 'Kubernetes', aliases: ['k8s'] },
  { name: 'Terraform' },
  { name: 'Jenkins' },
  { name: 'CI/CD', aliases: ['ci cd', 'continuous integration'] },
  { name: 'GitHub Actions' },
  { name: 'Git' },
  { name: 'Linux' },
  { name: 'Nginx' },
  // QA / process
  { name: 'Jest' },
  { name: 'Playwright' },
  { name: 'Cypress' },
  { name: 'Selenium' },
  { name: 'Test Automation', aliases: ['automated testing'] },
  { name: 'Agile', aliases: ['scrum'] },
  { name: 'Jira' },
  { name: 'Figma' },
  { name: 'UI/UX', aliases: ['ux design', 'ui design', 'user experience'] },
  // Business / HR / finance
  { name: 'Project Management' },
  { name: 'Product Management' },
  { name: 'Stakeholder Management' },
  { name: 'Leadership' },
  { name: 'Communication' },
  { name: 'Recruitment', aliases: ['talent acquisition'] },
  { name: 'Payroll' },
  { name: 'Employee Relations' },
  { name: 'Onboarding' },
  { name: 'HRIS' },
  { name: 'Accounting' },
  { name: 'Financial Reporting' },
  { name: 'Budgeting' },
  { name: 'Auditing', aliases: ['audit'] },
  { name: 'QuickBooks' },
  { name: 'SAP' },
  { name: 'Salesforce' },
  { name: 'SEO' },
  { name: 'Content Writing', aliases: ['copywriting'] },
  { name: 'Customer Service', aliases: ['customer support'] },
  { name: 'Sales' },
  { name: 'Negotiation' },
];

function loadExtraSkills(): SkillEntry[] {
  const path = process.env.RESUME_SKILLS_DICTIONARY_PATH;
  if (!path || !existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is SkillEntry => typeof e === 'object' && e !== null && typeof (e as SkillEntry).name === 'string');
  } catch {
    return [];
  }
}

export interface SkillDictionary {
  entries: SkillEntry[];
  /** lowercased name/alias → canonical name. */
  canonicalByKey: Map<string, string>;
}

export function buildSkillDictionary(extra: SkillEntry[] = loadExtraSkills()): SkillDictionary {
  const byName = new Map<string, SkillEntry>();
  for (const entry of [...DEFAULT_SKILLS, ...extra]) byName.set(entry.name.toLowerCase(), entry);
  const entries = [...byName.values()];
  const canonicalByKey = new Map<string, string>();
  for (const entry of entries) {
    canonicalByKey.set(entry.name.toLowerCase(), entry.name);
    for (const alias of entry.aliases ?? []) canonicalByKey.set(alias.toLowerCase(), entry.name);
  }
  return { entries, canonicalByKey };
}

/** The process-wide default dictionary (built once; the optional JSON file is read at first use). */
let defaultDictionary: SkillDictionary | undefined;
export function getDefaultSkillDictionary(): SkillDictionary {
  return (defaultDictionary ??= buildSkillDictionary());
}

/**
 * Normalise a free-typed skill (from criteria config or a recruiter's edit)
 * to its canonical dictionary spelling, or a trimmed lowercase-insensitive
 * form if unknown. Scoring compares ONLY canonicalised values, so aliases,
 * casing, and stray whitespace never cause a false "missed".
 */
export function canonicalSkill(raw: string, dictionary: SkillDictionary = getDefaultSkillDictionary()): string {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  return dictionary.canonicalByKey.get(trimmed.toLowerCase()) ?? trimmed;
}
