import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { Prisma } from '@hrm/db';
import { parsedResumeSchema, ParsedResume, UpdateParsedResumeInput } from '@hrm/shared';
import { RESUME_PARSE_QUEUE } from '../../queue/queue.constants';
import { StorageService } from '../../storage/storage.service';
import { ScreeningService } from '../screening/screening.service';
import { canonicalSkill } from './skills-dictionary';

export interface ResumeParseJobData {
  tenantId: string;
  candidateId: string;
  /** The exact stored object this job was queued for — a newer upload supersedes (and makes stale) any older job. */
  storageKey: string;
}

export interface StoredResumeFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

/**
 * The job is enqueued from inside the apply request's still-open RLS
 * transaction, so the worker may briefly look for a `Candidate` row that
 * hasn't committed yet — hence a short delay AND a generous retry budget with
 * exponential backoff (the processor throws on "row not visible yet").
 */
const JOB_OPTIONS = {
  delay: 500,
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: { age: 86400 },
};

function safeFileName(name: string): string {
  return name.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').slice(0, 120) || 'resume';
}

/**
 * Resume storage + parse lifecycle on a `Candidate` — see
 * docs/conventions/resume-parsing-screening.md → Async flow. Producer side
 * of the `RESUME_PARSE_QUEUE` job; the WorkerHost side is
 * `ResumeParseProcessor`. Also owns the recruiter's manual edit of the
 * parsed result, which re-scores the candidate's applications so edited data
 * is what gets screened.
 */
@Injectable()
export class ResumeParsingService {
  constructor(
    @InjectQueue(RESUME_PARSE_QUEUE) private readonly queue: Queue<ResumeParseJobData>,
    private readonly storage: StorageService,
    private readonly screening: ScreeningService,
  ) {}

  /** Store the file via the 1.1 `StorageService`, flip the candidate to `PENDING`, and queue the parse. Never parses inline. */
  async storeAndEnqueue(tx: Prisma.TransactionClient, tenantId: string, candidateId: string, file: StoredResumeFile): Promise<void> {
    const key = `candidates/${tenantId}/${candidateId}/resume-${Date.now()}-${safeFileName(file.originalname)}`;
    await this.storage.uploadObject({ key, body: file.buffer, contentType: file.mimetype });
    await tx.candidate.update({
      where: { id: candidateId },
      data: {
        resumeStorageKey: key,
        resumeFileName: file.originalname.slice(0, 255),
        resumeContentType: file.mimetype,
        parseStatus: 'PENDING',
        parsedData: Prisma.DbNull,
        parseError: null,
        parserName: null,
        parsedAt: null,
        parsedDataEditedAt: null,
        parsedDataEditedBy: null,
      },
    });
    // The old parsed data described the previous document: scores derived from it are no longer valid.
    await this.screening.rescoreForCandidate(tx, candidateId);
    await this.queue.add('parse', { tenantId, candidateId, storageKey: key }, JOB_OPTIONS);
  }

  /** Re-run the parser against the stored file (discarding any manual edits — the UI confirms this first). */
  async reparse(tx: Prisma.TransactionClient, tenantId: string, candidateId: string): Promise<void> {
    const candidate = await tx.candidate.findUnique({ where: { id: candidateId } });
    if (!candidate) throw new NotFoundException(`Candidate "${candidateId}" was not found.`);
    if (!candidate.resumeStorageKey) throw new ConflictException('This candidate has no stored resume to parse.');
    await tx.candidate.update({
      where: { id: candidateId },
      data: { parseStatus: 'PENDING', parsedData: Prisma.DbNull, parseError: null, parserName: null, parsedAt: null, parsedDataEditedAt: null, parsedDataEditedBy: null },
    });
    await this.screening.rescoreForCandidate(tx, candidateId);
    await this.queue.add('parse', { tenantId, candidateId, storageKey: candidate.resumeStorageKey }, JOB_OPTIONS);
  }

  /**
   * A recruiter's edit (or manual entry for a FAILED/NONE parse). The stored
   * `rawText` is server-owned and preserved. Skills are canonicalised the same
   * way the scorer and criteria are, so an edit can't create a spelling
   * mismatch. Marks the data as hand-edited and re-scores — so screening
   * always uses what the recruiter sees.
   */
  async updateParsedData(tx: Prisma.TransactionClient, candidateId: string, userId: string, input: UpdateParsedResumeInput): Promise<ParsedResume> {
    const candidate = await tx.candidate.findUnique({ where: { id: candidateId } });
    if (!candidate) throw new NotFoundException(`Candidate "${candidateId}" was not found.`);
    if (candidate.parseStatus === 'PENDING') {
      throw new ConflictException('The resume is still being parsed — wait for it to finish before editing.');
    }
    const previous = candidate.parsedData ? parsedResumeSchema.safeParse(candidate.parsedData) : null;
    const seen = new Set<string>();
    const skills = input.skills
      .map((s) => canonicalSkill(s))
      .filter((s) => {
        const k = s.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    const next: ParsedResume = parsedResumeSchema.parse({ ...input, skills, rawText: previous?.success ? previous.data.rawText : null });

    await tx.candidate.update({
      where: { id: candidateId },
      data: {
        parsedData: next as unknown as Prisma.InputJsonValue,
        parseStatus: 'PARSED',
        parseError: null,
        // A FAILED/NONE candidate being filled in by hand is attributed to 'manual', not the parser that failed.
        parserName: candidate.parseStatus === 'PARSED' ? (candidate.parserName ?? 'manual') : 'manual',
        parsedAt: candidate.parsedAt ?? new Date(),
        parsedDataEditedAt: new Date(),
        parsedDataEditedBy: userId,
      },
    });
    await this.screening.rescoreForCandidate(tx, candidateId);
    const { rawText: _omit, ...forClient } = next;
    return forClient as ParsedResume;
  }

  async downloadResume(tx: Prisma.TransactionClient, candidateId: string) {
    const candidate = await tx.candidate.findUnique({ where: { id: candidateId } });
    if (!candidate) throw new NotFoundException(`Candidate "${candidateId}" was not found.`);
    if (!candidate.resumeStorageKey) throw new NotFoundException('This candidate has no stored resume.');
    const { body, contentType } = await this.storage.downloadObject(candidate.resumeStorageKey);
    return { body, contentType: candidate.resumeContentType ?? contentType ?? 'application/octet-stream', fileName: candidate.resumeFileName ?? 'resume' };
  }
}
