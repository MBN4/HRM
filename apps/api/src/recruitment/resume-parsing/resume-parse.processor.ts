import { Inject, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Job } from 'bullmq';
import type { Readable } from 'stream';
import { Prisma, withTenantContext } from '@hrm/db';
import { parsedResumeSchema } from '@hrm/shared';
import { RESUME_PARSE_QUEUE } from '../../queue/queue.constants';
import { shouldAutorunWorkers } from '../../queue/queue-worker.util';
import { StorageService } from '../../storage/storage.service';
import { ScreeningService } from '../screening/screening.service';
import { RESUME_PARSER, ResumeParser, UnparseableResumeError } from './resume-parser.interface';
import { canonicalSkill } from './skills-dictionary';
import type { ResumeParseJobData } from './resume-parsing.service';

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * The resume-parse job's WORKER side — see
 * docs/conventions/resume-parsing-screening.md → Async flow. Context-less
 * (no `TenantContextService`), the posture every BullMQ processor here takes;
 * each DB phase runs in its own short `withTenantContext` transaction so the
 * (possibly slow) file download/parse never holds a DB transaction open.
 *
 * Outcomes:
 *  - parse OK                → candidate `PARSED`, applications re-scored.
 *  - `UnparseableResumeError`→ candidate `FAILED` (+ message), NOT retried —
 *                              the candidate/application already exist and
 *                              the recruiter can enter the fields by hand.
 *  - any other error         → BullMQ retries; on the final attempt the
 *                              candidate is marked `FAILED` too.
 *  - candidate row not yet visible (enqueued before the apply tx committed)
 *                            → throw → retry with backoff.
 *  - the stored key changed  → a newer upload superseded this job; no-op.
 */
@Processor(RESUME_PARSE_QUEUE, { autorun: shouldAutorunWorkers() })
export class ResumeParseProcessor extends WorkerHost {
  private readonly logger = new Logger(ResumeParseProcessor.name);

  constructor(
    @Inject(RESUME_PARSER) private readonly parser: ResumeParser,
    private readonly storage: StorageService,
    private readonly screening: ScreeningService,
    private readonly events: EventEmitter2,
  ) {
    super();
  }

  async process(job: Job<ResumeParseJobData>): Promise<void> {
    const { tenantId, candidateId, storageKey } = job.data;

    const candidate = await withTenantContext(tenantId, (tx) => tx.candidate.findUnique({ where: { id: candidateId } }));
    if (!candidate) {
      throw new Error(`Candidate "${candidateId}" is not visible yet (apply transaction may not have committed); retrying.`);
    }
    if (candidate.resumeStorageKey !== storageKey) {
      this.logger.log(`Skipping stale resume-parse job for candidate ${candidateId} (superseded by a newer upload).`);
      return;
    }

    try {
      const { body } = await this.storage.downloadObject(storageKey);
      const buffer = await streamToBuffer(body as Readable);
      const raw = await this.parser.parse({ buffer, fileName: candidate.resumeFileName ?? 'resume', contentType: candidate.resumeContentType });

      // Whatever parser is bound, what we store is validated against the shared shape and skills are canonicalised.
      const validated = parsedResumeSchema.parse(raw);
      const seen = new Set<string>();
      validated.skills = validated.skills
        .map((s) => canonicalSkill(s))
        .filter((s) => (seen.has(s.toLowerCase()) ? false : (seen.add(s.toLowerCase()), true)));

      await withTenantContext(tenantId, async (tx) => {
        const current = await tx.candidate.findUnique({ where: { id: candidateId }, select: { resumeStorageKey: true } });
        if (current?.resumeStorageKey !== storageKey) return; // superseded while parsing
        await tx.candidate.update({
          where: { id: candidateId },
          data: {
            parseStatus: 'PARSED',
            parsedData: validated as unknown as Prisma.InputJsonValue,
            parseError: null,
            parserName: this.parser.name,
            parsedAt: new Date(),
            parsedDataEditedAt: null,
            parsedDataEditedBy: null,
            // Pre-fill (never overwrite) the one contact field the apply form doesn't require.
            ...(candidate.phone ? {} : validated.phone ? { phone: validated.phone } : {}),
          },
        });
        await this.screening.rescoreForCandidate(tx, candidateId);
      });
      this.emit(tenantId, candidateId, 'recruitment.resume_parsed', 'PARSED');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const permanent = error instanceof UnparseableResumeError;
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (permanent || lastAttempt) {
        await withTenantContext(tenantId, async (tx) => {
          const current = await tx.candidate.findUnique({ where: { id: candidateId }, select: { resumeStorageKey: true } });
          if (current?.resumeStorageKey !== storageKey) return;
          await tx.candidate.update({ where: { id: candidateId }, data: { parseStatus: 'FAILED', parseError: message.slice(0, 500), parserName: this.parser.name } });
          await this.screening.rescoreForCandidate(tx, candidateId);
        });
        this.emit(tenantId, candidateId, 'recruitment.resume_parse_failed', 'FAILED');
      }
      if (!permanent) throw error;
    }
  }

  /** No PII in the payload — ids + status only; picked up by the generic `recruitment.*` audit subscription. */
  private emit(tenantId: string, candidateId: string, type: string, status: string): void {
    this.events.emit(type, { type, tenantId, candidateId, status, parserName: this.parser.name });
  }
}
