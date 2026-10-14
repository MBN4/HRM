import { ResumeParser, ResumeParserInput, UnparseableResumeError } from './resume-parser.interface';
import type { ParsedResume } from '@hrm/shared';

/**
 * A documented SEAM ONLY — what `RESUME_PARSER_PROVIDER=external-api` (or
 * `llm`) binds until a real integration is written, the same posture
 * `AcmeCertProvider` takes. Deliberately throws rather than silently falling
 * back to the built-in parser, so a misconfigured deployment fails loudly
 * (the parse is marked FAILED with this message, without retries; candidates stay usable)
 * instead of quietly producing lower-quality data than the operator thinks
 * they're getting. See docs/conventions/resume-parsing-screening.md → How to
 * swap in a better parser.
 */
export class UnavailableResumeParser implements ResumeParser {
  readonly name: string;

  constructor(private readonly provider: string) {
    this.name = `${provider}-unconfigured`;
  }

  async parse(_input: ResumeParserInput): Promise<ParsedResume> {
    throw new UnparseableResumeError(
      `RESUME_PARSER_PROVIDER="${this.provider}" is a documented seam only — no ${this.provider} parser is implemented in this codebase. Implement the ResumeParser interface and bind it in RecruitmentModule, or unset RESUME_PARSER_PROVIDER to use the built-in parser.`,
    );
  }
}
