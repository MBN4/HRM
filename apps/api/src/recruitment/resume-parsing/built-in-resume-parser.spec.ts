import { zipSync, strToU8 } from 'fflate';
import { BuiltInResumeParser, computeTotalYears } from './built-in-resume-parser';
import { UnparseableResumeError } from './resume-parser.interface';
import { extractResumeText } from './text-extractor';

const SENIOR = `Sara Ahmed
Senior Software Engineer
sara.ahmed@example.com | +92 300 1234567 | https://www.linkedin.com/in/saraahmed | github.com/saraahmed

Summary
Backend engineer with 8 years of experience building scalable APIs.

Skills
Languages: TypeScript, Python, Go
Frameworks: NestJS, React, Node.js
Cloud: AWS, Docker, k8s, PostgreSQL

Work Experience
Senior Software Engineer at Acme Corp
Jan 2019 - Present
- Built microservices with NestJS and PostgreSQL.
- Led a team of five.

Software Engineer, Globex
06/2015 - 12/2018
- Developed REST APIs in Python and Django.

Education
Bachelor of Science in Computer Science
FAST National University, 2015
`;

describe('BuiltInResumeParser.parseText', () => {
  const parser = new BuiltInResumeParser();
  const now = new Date(Date.UTC(2026, 0, 15));
  const parsed = parser.parseText(SENIOR, now);

  it('extracts identity + contact + links', () => {
    expect(parsed.fullName).toBe('Sara Ahmed');
    expect(parsed.email).toBe('sara.ahmed@example.com');
    expect(parsed.phone).toContain('300');
    expect(parsed.links.join(' ')).toContain('linkedin.com/in/saraahmed');
    expect(parsed.links.join(' ')).toContain('github.com/saraahmed');
  });

  it('extracts dictionary skills (aliases canonicalised, ambiguous only in the skills section)', () => {
    expect(parsed.skills).toEqual(expect.arrayContaining(['TypeScript', 'Python', 'Go', 'NestJS', 'React', 'Node.js', 'AWS', 'Docker', 'Kubernetes', 'PostgreSQL', 'Django']));
    expect(parsed.skills).not.toContain('k8s');
  });

  it('extracts experience entries with normalised dates', () => {
    expect(parsed.experience).toHaveLength(2);
    expect(parsed.experience[0]).toMatchObject({ title: 'Senior Software Engineer', company: 'Acme Corp', startDate: '2019-01', endDate: 'present' });
    expect(parsed.experience[1]).toMatchObject({ title: 'Software Engineer', company: 'Globex', startDate: '2015-06', endDate: '2018-12' });
    expect(parsed.experience[0].description).toContain('microservices');
  });

  it('computes total years from the merged date ranges', () => {
    // Jun 2015–Dec 2018 (43 months, inclusive) + Jan 2019–Jan 2026 (85) = 128 months
    expect(parsed.totalYearsExperience).toBe(10.7);
  });

  it('extracts education with level and year', () => {
    expect(parsed.education[0]).toMatchObject({ level: 'BACHELOR', endYear: 2015 });
    expect(parsed.education[0].institution).toContain('FAST National University');
  });

  it('does not treat "go" prose or "MS Office" as skills/degrees', () => {
    const p = parser.parseText('Jo Bloggs\nWork Experience\nWe go to market fast and use MS Office daily for reporting purposes.\n');
    expect(p.skills).not.toContain('Go');
    expect(p.education).toHaveLength(0);
  });
});

describe('computeTotalYears', () => {
  it('merges overlapping ranges instead of double counting', () => {
    const now = new Date(Date.UTC(2026, 0, 1));
    expect(computeTotalYears([{ startDate: '2020', endDate: '2022' }, { startDate: '2021', endDate: '2023' }], now)).toBe(4);
  });
  it('returns null with no dated experience', () => {
    expect(computeTotalYears([{ title: 'x' }])).toBeNull();
  });
});

describe('extractResumeText', () => {
  it('reads TXT and DOCX', async () => {
    const txt = await extractResumeText(Buffer.from(SENIOR), 'cv.txt', 'text/plain');
    expect(txt).toContain('Sara Ahmed');
    const xml = `<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>Jane Doe &amp; Co</w:t></w:r></w:p><w:p><w:r><w:t>jane.doe@example.com is my email address ok</w:t></w:r></w:p></w:body></w:document>`;
    const docx = Buffer.from(zipSync({ 'word/document.xml': strToU8(xml) }));
    const out = await extractResumeText(docx, 'cv.docx');
    expect(out).toContain('Jane Doe & Co');
    expect(out).toContain('jane.doe@example.com');
  });
  it('rejects garbage, legacy .doc and tiny/empty files as unparseable', async () => {
    await expect(extractResumeText(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]), 'x.bin')).rejects.toBeInstanceOf(UnparseableResumeError);
    await expect(extractResumeText(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0]), 'x.doc')).rejects.toBeInstanceOf(UnparseableResumeError);
    await expect(extractResumeText(Buffer.from('hi'), 'x.txt', 'text/plain')).rejects.toBeInstanceOf(UnparseableResumeError);
    await expect(extractResumeText(Buffer.from('%PDF-1.4 not really a pdf'), 'x.pdf')).rejects.toBeInstanceOf(UnparseableResumeError);
  });
});
