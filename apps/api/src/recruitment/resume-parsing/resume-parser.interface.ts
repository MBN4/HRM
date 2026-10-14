import type { ParsedResume } from '@hrm/shared';

/**
 * DI token for the swappable resume parser — see
 * docs/conventions/resume-parsing-screening.md → The parser seam. The SAME
 * Symbol-token adapter shape `STRIPE_CLIENT`/`CERT_PROVIDER`/
 * `EMAIL_PROVIDER` already establish: one interface, a default
 * implementation that needs no external account, and a config switch
 * (`RESUME_PARSER_PROVIDER`) that swaps the binding in `RecruitmentModule`.
 */
export const RESUME_PARSER = Symbol('RESUME_PARSER');

export interface ResumeParserInput {
  buffer: Buffer;
  fileName: string;
  contentType?: string | null;
}

export interface ResumeParser {
  /** Stored on `Candidate.parserName` so a result is always attributable to the parser that produced it. */
  readonly name: string;
  /**
   * Turn a resume file into the structured `ParsedResume` shape. MUST throw
   * `UnparseableResumeError` for a file it cannot read at all (unsupported
   * type, no extractable text) — the worker marks the parse FAILED with that
   * message and the candidate stays fully usable. Any other thrown error is
   * treated as transient and retried by BullMQ.
   */
  parse(input: ResumeParserInput): Promise<ParsedResume>;
}

/** A permanent, file-level failure — never retried, always recorded on `Candidate.parseError`. */
export class UnparseableResumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnparseableResumeError';
  }
}
