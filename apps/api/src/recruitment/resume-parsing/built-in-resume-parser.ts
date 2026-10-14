import { Injectable } from '@nestjs/common';
import type { EducationLevel, ParsedEducation, ParsedExperience, ParsedResume } from '@hrm/shared';
import { ResumeParser, ResumeParserInput } from './resume-parser.interface';
import { extractResumeText } from './text-extractor';
import { getDefaultSkillDictionary, SkillDictionary } from './skills-dictionary';

type SectionKey = 'summary' | 'experience' | 'education' | 'skills' | 'other';

const SECTION_HEADINGS: Record<SectionKey, string[]> = {
  summary: ['summary', 'professional summary', 'profile', 'objective', 'career objective', 'about me', 'about'],
  experience: ['experience', 'work experience', 'professional experience', 'employment history', 'work history', 'employment', 'career history', 'relevant experience'],
  education: ['education', 'academic background', 'academics', 'qualifications', 'education and training', 'academic qualifications'],
  skills: ['skills', 'technical skills', 'key skills', 'core competencies', 'skills and tools', 'technologies', 'tools', 'skills and technologies', 'core skills'],
  other: ['projects', 'certifications', 'certificates', 'languages', 'interests', 'hobbies', 'references', 'awards', 'publications', 'achievements', 'courses', 'training', 'volunteering', 'volunteer experience', 'personal details'],
};

const HEADING_LOOKUP = new Map<string, SectionKey>();
for (const [key, names] of Object.entries(SECTION_HEADINGS)) for (const n of names) HEADING_LOOKUP.set(n, key as SectionKey);

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
};
const MONTH_RE = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_TOKEN = `(?:${MONTH_RE}\\.?\\s+(?:19|20)\\d{2}|(?:0?[1-9]|1[0-2])\\/(?:19|20)\\d{2}|(?:19|20)\\d{2})`;
const END_TOKEN = `(?:${DATE_TOKEN}|present|current|now|till date|to date|ongoing)`;
const DATE_RANGE_RE = new RegExp(`(${DATE_TOKEN})\\s*(?:-|–|—|to|until)\\s*(${END_TOKEN})`, 'i');

const TITLE_WORDS = /\b(engineer|developer|manager|analyst|designer|lead|director|intern|consultant|specialist|officer|administrator|architect|accountant|executive|coordinator|assistant|associate|head|vp|president|scientist|tester|qa|representative|supervisor|recruiter|programmer|technician|teacher|nurse|clerk|owner|founder|cto|ceo|cfo)\b/i;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"')]+|(?:linkedin\.com|github\.com|gitlab\.com|behance\.net)\/[^\s<>"')]+/gi;
const BULLET_RE = /^\s*[-•*·▪●◦–]\s*/;

const DEGREE_PATTERNS: Array<{ level: EducationLevel; re: RegExp }> = [
  { level: 'DOCTORATE', re: /\b(ph\.?\s?d|doctorate|doctor of)\b/i },
  { level: 'MASTER', re: /\b(master'?s?|m\.?\s?sc|mba|m\.?\s?tech|m\.?\s?eng|msc|m\.phil)\b/i },
  { level: 'BACHELOR', re: /\b(bachelor'?s?|b\.?\s?sc|b\.?\s?tech|b\.?\s?eng|bsc|bba|bscs|bs\s?cs|undergraduate degree)\b/i },
  { level: 'DIPLOMA', re: /\b(diploma|associate degree|associate of)\b/i },
  { level: 'HIGH_SCHOOL', re: /\b(high school|secondary school|hsc|ssc|a-levels?|matric(?:ulation)?|intermediate|f\.?sc|o-levels?)\b/i },
];
/** Bare abbreviations are only trusted inside an Education section (they collide with "MS Office", "ME" etc. elsewhere). */
const BARE_DEGREE_PATTERNS: Array<{ level: EducationLevel; re: RegExp }> = [
  { level: 'MASTER', re: /\b(MS|MA|ME)\b(?=\s+in\b|[,.\s]*$|\s+\(|,)/ },
  { level: 'BACHELOR', re: /\b(BS|BA|BE)\b(?=\s+in\b|[,.\s]*$|\s+\(|,)/ },
];
const INSTITUTION_RE = /\b(university|college|institute|school|academy|polytechnic|universität|université)\b/i;

function normaliseHeading(line: string): string {
  return line.toLowerCase().replace(/[^a-z& ]/g, ' ').replace(/&/g, 'and').replace(/\s+/g, ' ').trim();
}

function tidyDate(raw: string): string | null {
  const lower = raw.toLowerCase().trim();
  if (/^(present|current|now|till date|to date|ongoing)$/.test(lower)) return 'present';
  const named = lower.match(new RegExp(`^(${MONTH_RE})\\.?\\s+((?:19|20)\\d{2})$`));
  if (named) return `${named[2]}-${MONTHS[named[1].slice(0, named[1].startsWith('sept') ? 4 : 3)] ?? '01'}`;
  const slash = lower.match(/^(0?[1-9]|1[0-2])\/((?:19|20)\d{2})$/);
  if (slash) return `${slash[2]}-${slash[1].padStart(2, '0')}`;
  const year = lower.match(/^((?:19|20)\d{2})$/);
  return year ? year[1] : null;
}

/** `YYYY`/`YYYY-MM`/`present` → a month index (year*12+month), start dates default to month 1, end dates to month 12. */
function toMonthIndex(value: string, isEnd: boolean, now: Date): number | null {
  if (value === 'present') return now.getUTCFullYear() * 12 + now.getUTCMonth();
  const m = value.match(/^(\d{4})(?:-(\d{2}))?$/);
  if (!m) return null;
  const month = m[2] ? Number(m[2]) - 1 : isEnd ? 11 : 0;
  return Number(m[1]) * 12 + month;
}

export function computeTotalYears(experience: ParsedExperience[], now = new Date()): number | null {
  const intervals: Array<[number, number]> = [];
  for (const e of experience) {
    if (!e.startDate) continue;
    const start = toMonthIndex(e.startDate, false, now);
    const end = toMonthIndex(e.endDate ?? 'present', true, now);
    if (start === null || end === null || end < start) continue;
    intervals.push([start, Math.min(end, now.getUTCFullYear() * 12 + now.getUTCMonth())]);
  }
  if (intervals.length === 0) return null;
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curStart, curEnd] = intervals[0];
  for (const [s, e] of intervals.slice(1)) {
    if (s <= curEnd) curEnd = Math.max(curEnd, e);
    else {
      total += curEnd - curStart + 1;
      [curStart, curEnd] = [s, e];
    }
  }
  total += curEnd - curStart + 1; // month indexes are inclusive on both ends
  return Math.round((total / 12) * 10) / 10;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The DEFAULT, built-in resume parser — heuristic and dependency-light (text
 * extraction via `pdf-parse`/`fflate`; everything else is regex + a skills
 * dictionary). It is a "good enough to pre-fill + screen" parser, NOT a
 * high-accuracy one: see docs/conventions/resume-parsing-screening.md →
 * Default parser accuracy for exactly what it gets right and wrong. Every
 * field it produces is shown to, and editable by, the recruiter.
 */
@Injectable()
export class BuiltInResumeParser implements ResumeParser {
  readonly name = 'built-in-heuristic-v1';

  constructor(private readonly dictionary: SkillDictionary = getDefaultSkillDictionary()) {}

  async parse(input: ResumeParserInput): Promise<ParsedResume> {
    const text = await extractResumeText(input.buffer, input.fileName, input.contentType);
    return this.parseText(text);
  }

  /** Exposed (and unit-tested) separately from file extraction so the field heuristics can be tested on plain text. */
  parseText(text: string, now = new Date()): ParsedResume {
    const lines = text.split('\n').map((l) => l.trim());
    const sections = this.splitSections(lines);

    const email = text.match(EMAIL_RE)?.[0] ?? null;
    const phone = this.findPhone(text);
    const links = this.findLinks(text);
    const experience = this.parseExperience(sections.experience);
    const education = this.parseEducation(sections.education, lines);
    const skills = this.findSkills(text, sections.skills);

    let totalYears = computeTotalYears(experience, now);
    if (totalYears === null) {
      const claimed = [...text.matchAll(/(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/gi)].map((m) => Number(m[1])).filter((n) => n > 0 && n <= 50);
      if (claimed.length > 0) totalYears = Math.max(...claimed);
    }

    const summaryText = sections.summary.join(' ').trim();

    return {
      fullName: this.findName(lines),
      email,
      phone,
      skills,
      experience,
      education,
      totalYearsExperience: totalYears,
      links,
      summary: summaryText ? summaryText.slice(0, 600) : null,
      rawText: text.slice(0, 30000),
    };
  }

  private splitSections(lines: string[]): Record<SectionKey, string[]> {
    const sections: Record<SectionKey, string[]> = { summary: [], experience: [], education: [], skills: [], other: [] };
    let current: SectionKey | null = null;
    for (const line of lines) {
      if (line.length > 0 && line.length <= 45) {
        const heading = HEADING_LOOKUP.get(normaliseHeading(line));
        if (heading) {
          current = heading;
          continue;
        }
      }
      if (current) sections[current].push(line);
    }
    return sections;
  }

  private findName(lines: string[]): string | null {
    for (const line of lines.slice(0, 10)) {
      if (!line || line.length > 60) continue;
      if (EMAIL_RE.test(line) || /\d/.test(line) || /https?:|www\./i.test(line)) continue;
      if (HEADING_LOOKUP.has(normaliseHeading(line))) continue;
      const words = line.split(/\s+/);
      if (words.length < 2 || words.length > 4) continue;
      if (/^(curriculum vitae|resume|cv)$/i.test(line)) continue;
      if (!words.every((w) => /^[\p{L}][\p{L}.'’-]*$/u.test(w))) continue;
      return line;
    }
    return null;
  }

  private findPhone(text: string): string | null {
    for (const match of text.matchAll(PHONE_RE)) {
      const digits = match[0].replace(/\D/g, '');
      // Skip year ranges ("2018 - 2021") that happen to satisfy the loose pattern.
      if (digits.length >= 8 && digits.length <= 15 && !/^(?:19|20)\d{2}\D*(?:19|20)\d{2}$/.test(match[0].trim())) return match[0].trim();
    }
    return null;
  }

  private findLinks(text: string): string[] {
    const found = new Set<string>();
    for (const m of text.matchAll(URL_RE)) {
      const url = m[0].replace(/[.,;:)]+$/, '');
      if (!url.includes('@')) found.add(url);
    }
    return [...found].slice(0, 20);
  }

  private findSkills(text: string, skillsSection: string[]): string[] {
    const found = new Map<string, string>(); // lower → display
    const add = (name: string) => {
      if (!found.has(name.toLowerCase())) found.set(name.toLowerCase(), name);
    };
    const skillsText = skillsSection.join('\n');

    for (const entry of this.dictionary.entries) {
      const forms = [entry.name, ...(entry.aliases ?? [])];
      for (const form of forms) {
        const body = escapeRegex(form).replace(/\\ /g, '\\s+');
        const pattern = `(?<![A-Za-z0-9+#.])${body}(?![A-Za-z0-9+#]|\\.[A-Za-z0-9])`;
        if (entry.ambiguous) {
          if (new RegExp(pattern).test(skillsText) && form === entry.name) add(entry.name);
        } else if (new RegExp(pattern, 'i').test(text)) {
          add(entry.name);
          break;
        }
      }
    }

    // Unknown items listed in a Skills section ("Category: a, b, c" / bullets) — kept so a niche skill isn't lost.
    for (const rawLine of skillsSection) {
      const afterColon = rawLine.includes(':') ? rawLine.slice(rawLine.indexOf(':') + 1) : rawLine;
      for (const part of afterColon.replace(BULLET_RE, '').split(/[,;|•·]/)) {
        const item = part.trim().replace(/[.]+$/, '');
        if (!item || item.length > 30 || item.split(/\s+/).length > 3 || /^\d+$/.test(item)) continue;
        const canonical = this.dictionary.canonicalByKey.get(item.toLowerCase());
        add(canonical ?? item);
      }
    }
    return [...found.values()].slice(0, 100);
  }

  private splitHeader(header: string): { title: string | null; company: string | null } {
    const cleaned = header.replace(/[|•·]+/g, ' | ').trim();
    const parts = cleaned
      .split(/\s+(?:at|@)\s+|\s+\|\s+|\s+[–—-]\s+|,\s+/i)
      .map((p) => p.trim().replace(/^[,.\-–—|]+|[,.\-–—|]+$/g, '').trim())
      .filter(Boolean);
    return this.pickTitleCompany(parts);
  }

  private pickTitleCompany(parts: string[]): { title: string | null; company: string | null } {
    if (parts.length === 0) return { title: null, company: null };
    if (parts.length === 1) return TITLE_WORDS.test(parts[0]) ? { title: parts[0], company: null } : { title: null, company: parts[0] };
    const [a, b] = parts;
    const aTitle = TITLE_WORDS.test(a);
    const bTitle = TITLE_WORDS.test(b);
    if (bTitle && !aTitle) return { title: b, company: a };
    return { title: a, company: b };
  }

  private parseExperience(section: string[]): ParsedExperience[] {
    const entries: ParsedExperience[] = [];
    let buffer: string[] = [];
    let current: ParsedExperience | null = null;
    const descriptions = new Map<ParsedExperience, string[]>();

    for (const line of section) {
      if (!line) continue;
      const range = line.match(DATE_RANGE_RE);
      if (range) {
        const start = tidyDate(range[1]);
        const end = tidyDate(range[2]);
        const headerOnLine = line.replace(DATE_RANGE_RE, ' ').replace(/[()]/g, ' ').trim();
        const headerLines = [...buffer.slice(-2), ...(headerOnLine && /[\p{L}]/u.test(headerOnLine) ? [headerOnLine] : [])];
        let title: string | null = null;
        let company: string | null = null;
        if (headerLines.length >= 2) {
          const picked = this.pickTitleCompany([headerLines[headerLines.length - 2], headerLines[headerLines.length - 1]].map((h) => h.replace(/[,|]+$/, '').trim()));
          title = picked.title;
          company = picked.company;
        } else if (headerLines.length === 1) {
          ({ title, company } = this.splitHeader(headerLines[0]));
        }
        current = { title, company, startDate: start, endDate: end };
        entries.push(current);
        descriptions.set(current, []);
        buffer = [];
        continue;
      }
      const isBullet = BULLET_RE.test(line);
      if (!isBullet && line.length <= 80 && !/[.!?]$/.test(line)) {
        buffer.push(line);
      } else if (current) {
        descriptions.get(current)!.push(line.replace(BULLET_RE, '').trim());
        buffer = [];
      }
    }
    for (const entry of entries) {
      const d = descriptions.get(entry)!.join(' ').trim();
      if (d) entry.description = d.slice(0, 1500);
    }
    return entries.slice(0, 50);
  }

  private parseEducation(section: string[], allLines: string[]): ParsedEducation[] {
    const useSection = section.length > 0;
    const lines = useSection ? section : allLines;
    const out: ParsedEducation[] = [];
    const yearOf = (s: string): number | null => {
      const years = [...s.matchAll(/\b((?:19|20)\d{2})\b/g)].map((m) => Number(m[1]));
      return years.length ? years[years.length - 1] : null;
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      let level: EducationLevel | null = null;
      for (const p of DEGREE_PATTERNS) if (p.re.test(line)) { level = p.level; break; }
      if (!level && useSection) for (const p of BARE_DEGREE_PATTERNS) if (p.re.test(line)) { level = p.level; break; }
      if (!level) continue;
      // High-school keywords are far too common in free text to trust outside an Education section.
      if (!useSection && level === 'HIGH_SCHOOL') continue;

      const neighbours = [lines[i - 1], line, lines[i + 1]].filter((l): l is string => !!l);
      const institutionLine = neighbours.find((l) => INSTITUTION_RE.test(l));
      const fieldMatch = line.match(/\bin\s+([\p{L}][\p{L}&\s]{2,60})/u);
      out.push({
        degree: line.replace(/\b(?:19|20)\d{2}\b/g, '').replace(/[()|–—-]+\s*$/g, '').replace(/\s+/g, ' ').trim().slice(0, 200) || null,
        field: fieldMatch ? fieldMatch[1].replace(/\s+(from|at)\s.*$/i, '').trim() : null,
        institution: institutionLine ? institutionLine.replace(/\b(?:19|20)\d{2}\b/g, '').replace(/[()|–—,-]+\s*$/g, '').trim().slice(0, 200) : null,
        level,
        endYear: yearOf(neighbours.join(' ')),
      });
    }
    // De-duplicate (the fallback whole-text scan can hit the same degree twice).
    const seen = new Set<string>();
    return out
      .filter((e) => {
        const key = `${e.level}|${e.degree}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 20);
  }
}
