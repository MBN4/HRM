import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@hrm/db';
import {
  parsedResumeSchema,
  ParsedResume,
  RankedApplicationsQuery,
  screeningCriteriaConfigSchema,
  ScreeningCriteriaConfig,
  ScreeningResult,
  UpsertScreeningCriteriaInput,
} from '@hrm/shared';
import { JobRequisitionService } from '../requisitions/job-requisition.service';
import { MAX_LIST_RESULTS } from '../recruitment.constants';
import { canonicalSkill } from '../resume-parsing/skills-dictionary';
import { highestEducationLevel, scoreResume } from './screening-scorer.util';

/** An upper bound on one re-score pass; a requisition with more applicants than this is re-scored in the next pass the recruiter triggers (documented limit). */
const MAX_RESCORE_APPLICATIONS = 5000;

const candidateScreeningSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  parseStatus: true,
  parsedData: true,
  parsedDataEditedAt: true,
} satisfies Prisma.CandidateSelect;

/**
 * Screening criteria + scoring orchestration — see
 * docs/conventions/resume-parsing-screening.md. All the actual scoring is
 * the pure `scoreResume`; this service only (a) stores criteria as validated
 * DATA, (b) loads the right inputs, (c) persists the result on `Application`,
 * and (d) serves the ranked/filterable list. NOTHING in here ever touches
 * `Application.stage` — scoring assists a human, never decides for them.
 */
@Injectable()
export class ScreeningService {
  constructor(private readonly requisitions: JobRequisitionService) {}

  // --- Criteria (config data) -------------------------------------------------

  async getCriteria(tx: Prisma.TransactionClient, requisitionId: string, allowedBranchIds: string[] | null) {
    await this.requisitions.findById(tx, requisitionId, allowedBranchIds);
    const row = await tx.screeningCriteria.findFirst({ where: { requisitionId } });
    return row ? { requisitionId, config: this.parseConfig(row.config), updatedAt: row.updatedAt } : { requisitionId, config: null, updatedAt: null };
  }

  async upsertCriteria(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
    requisitionId: string,
    allowedBranchIds: string[] | null,
    input: UpsertScreeningCriteriaInput,
  ) {
    await this.requisitions.findById(tx, requisitionId, allowedBranchIds);
    const config = screeningCriteriaConfigSchema.parse(input);
    // Store skills in their canonical spelling so the config reads the same way resumes do.
    const normalised: ScreeningCriteriaConfig = {
      ...config,
      requiredSkills: this.canonicalList(config.requiredSkills),
      preferredSkills: this.canonicalList(config.preferredSkills),
    };
    const row = await tx.screeningCriteria.upsert({
      where: { tenantId_requisitionId: { tenantId, requisitionId } },
      update: { config: normalised as unknown as Prisma.InputJsonValue, updatedByUserId: userId },
      create: { tenantId, requisitionId, config: normalised as unknown as Prisma.InputJsonValue, updatedByUserId: userId },
    });
    const rescored = await this.rescoreForRequisition(tx, requisitionId);
    return { requisitionId, config: normalised, updatedAt: row.updatedAt, rescored };
  }

  async deleteCriteria(tx: Prisma.TransactionClient, tenantId: string, requisitionId: string, allowedBranchIds: string[] | null) {
    await this.requisitions.findById(tx, requisitionId, allowedBranchIds);
    await tx.screeningCriteria.deleteMany({ where: { tenantId, requisitionId } });
    const rescored = await this.rescoreForRequisition(tx, requisitionId);
    return { deleted: true, rescored };
  }

  private canonicalList(list: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of list) {
      const c = canonicalSkill(s);
      if (!seen.has(c.toLowerCase())) {
        seen.add(c.toLowerCase());
        out.push(c);
      }
    }
    return out;
  }

  private parseConfig(raw: unknown): ScreeningCriteriaConfig {
    return screeningCriteriaConfigSchema.parse(raw);
  }

  // --- Scoring ---------------------------------------------------------------------

  /** Re-score every application of one candidate (after a parse finishes or a recruiter edits the parsed data). */
  async rescoreForCandidate(tx: Prisma.TransactionClient, candidateId: string): Promise<number> {
    return this.rescore(tx, { candidateId });
  }

  /** Re-score every application under one requisition (after its criteria change). */
  async rescoreForRequisition(tx: Prisma.TransactionClient, requisitionId: string): Promise<number> {
    return this.rescore(tx, { jobPosting: { requisitionId } });
  }

  private async rescore(tx: Prisma.TransactionClient, where: Prisma.ApplicationWhereInput): Promise<number> {
    const applications = await tx.application.findMany({
      where,
      take: MAX_RESCORE_APPLICATIONS,
      select: { id: true, jobPosting: { select: { requisitionId: true } }, candidate: { select: candidateScreeningSelect } },
    });
    const configByRequisition = new Map<string, ScreeningCriteriaConfig | null>();
    const now = new Date();

    for (const app of applications) {
      const requisitionId = app.jobPosting.requisitionId;
      if (!configByRequisition.has(requisitionId)) {
        const row = await tx.screeningCriteria.findFirst({ where: { requisitionId } });
        configByRequisition.set(requisitionId, row ? this.parseConfig(row.config) : null);
      }
      const config = configByRequisition.get(requisitionId) ?? null;
      const parsed = this.readParsed(app.candidate);

      const result: ScreeningResult | null =
        config && parsed && app.candidate.parseStatus === 'PARSED'
          ? scoreResume({ parsed, config, basedOnEditedData: app.candidate.parsedDataEditedAt !== null, now })
          : null;

      await tx.application.update({
        where: { id: app.id },
        data: {
          screeningScore: result?.score ?? null,
          screeningResult: result ? (result as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          belowThreshold: result?.belowThreshold ?? false,
          screenedAt: result ? now : null,
        },
      });
    }
    return applications.length;
  }

  private readParsed(candidate: { parsedData: Prisma.JsonValue | null }): ParsedResume | null {
    if (!candidate.parsedData) return null;
    const result = parsedResumeSchema.safeParse(candidate.parsedData);
    return result.success ? result.data : null;
  }

  // --- Reads -----------------------------------------------------------------------

  /** Applicants for a requisition, ranked/filtered. Bounded (MAX_LIST_RESULTS) — filters on parsed JSON run in memory over that bounded set. */
  async ranked(tx: Prisma.TransactionClient, requisitionId: string, allowedBranchIds: string[] | null, query: RankedApplicationsQuery) {
    await this.requisitions.findById(tx, requisitionId, allowedBranchIds);

    const where: Prisma.ApplicationWhereInput = { jobPosting: { requisitionId } };
    if (query.jobPostingId) where.jobPostingId = query.jobPostingId;
    if (query.stage) where.stage = query.stage as Prisma.ApplicationWhereInput['stage'];
    if (query.minScore !== undefined) where.screeningScore = { gte: query.minScore };
    if (query.belowThreshold) where.belowThreshold = query.belowThreshold === 'true';

    const rows = await tx.application.findMany({
      where,
      orderBy: [{ screeningScore: { sort: 'desc', nulls: 'last' } }, { appliedAt: 'asc' }],
      take: MAX_LIST_RESULTS,
      include: { candidate: { select: candidateScreeningSelect }, jobPosting: { select: { id: true, title: true } } },
    });

    const wantedSkill = query.skill ? canonicalSkill(query.skill).toLowerCase() : null;
    const items = rows
      .map((row) => {
        const parsed = this.readParsed(row.candidate);
        return {
          applicationId: row.id,
          candidateId: row.candidateId,
          jobPostingId: row.jobPostingId,
          jobPostingTitle: row.jobPosting.title,
          stage: row.stage,
          appliedAt: row.appliedAt,
          candidate: {
            firstName: row.candidate.firstName,
            lastName: row.candidate.lastName,
            email: row.candidate.email,
            parseStatus: row.candidate.parseStatus,
            edited: row.candidate.parsedDataEditedAt !== null,
            skills: parsed?.skills ?? [],
            totalYearsExperience: parsed?.totalYearsExperience ?? null,
            highestEducation: parsed ? highestEducationLevel(parsed) : null,
          },
          screeningScore: row.screeningScore,
          belowThreshold: row.belowThreshold,
          screening: (row.screeningResult as unknown as ScreeningResult | null) ?? null,
        };
      })
      .filter((item) => {
        if (query.minYears !== undefined && (item.candidate.totalYearsExperience ?? 0) < query.minYears) return false;
        if (wantedSkill && !item.candidate.skills.some((s) => canonicalSkill(s).toLowerCase() === wantedSkill)) return false;
        return true;
      });

    if (query.sort === 'experience') items.sort((a, b) => (b.candidate.totalYearsExperience ?? -1) - (a.candidate.totalYearsExperience ?? -1));
    else if (query.sort === 'appliedAt') items.sort((a, b) => b.appliedAt.getTime() - a.appliedAt.getTime());
    // 'score' is already the DB order (nulls last, earlier applicants first on ties).
    return items;
  }

  /** One application's full screening view: parsed data (editable), parse status, score + breakdown. */
  async getApplicationScreening(tx: Prisma.TransactionClient, applicationId: string, allowedBranchIds: string[] | null) {
    const app = await tx.application.findUnique({
      where: { id: applicationId },
      include: {
        candidate: true,
        jobPosting: { select: { id: true, title: true, requisitionId: true, requisition: { select: { branchId: true, title: true } } } },
      },
    });
    if (!app) throw new NotFoundException(`Application "${applicationId}" was not found.`);
    if (allowedBranchIds && !allowedBranchIds.includes(app.jobPosting.requisition.branchId)) {
      throw new ForbiddenException('You are not permitted to view applications for this branch.');
    }
    const parsed = this.readParsed(app.candidate);
    const { rawText: _omit, ...parsedForUi } = parsed ?? ({} as ParsedResume);
    const criteriaRow = await tx.screeningCriteria.findFirst({ where: { requisitionId: app.jobPosting.requisitionId } });
    return {
      applicationId: app.id,
      stage: app.stage,
      jobPosting: { id: app.jobPosting.id, title: app.jobPosting.title, requisitionId: app.jobPosting.requisitionId },
      candidate: {
        id: app.candidate.id,
        firstName: app.candidate.firstName,
        lastName: app.candidate.lastName,
        email: app.candidate.email,
        phone: app.candidate.phone,
        hasResume: !!app.candidate.resumeStorageKey,
        resumeFileName: app.candidate.resumeFileName,
      },
      parse: {
        status: app.candidate.parseStatus,
        error: app.candidate.parseError,
        parserName: app.candidate.parserName,
        parsedAt: app.candidate.parsedAt,
        editedAt: app.candidate.parsedDataEditedAt,
      },
      parsed: parsed ? parsedForUi : null,
      screening: (app.screeningResult as unknown as ScreeningResult | null) ?? null,
      screeningScore: app.screeningScore,
      belowThreshold: app.belowThreshold,
      criteria: criteriaRow ? this.parseConfig(criteriaRow.config) : null,
    };
  }
}

