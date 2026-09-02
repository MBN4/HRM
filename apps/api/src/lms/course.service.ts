import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Course, CourseContentItem, Prisma } from '@hrm/db';
import { CreateContentItemInput, CreateCourseInput, UpdateCourseInput } from '@hrm/shared';
import { CourseCategoryService } from './course-category.service';

export type CourseWithContent = Course & { contentItems: CourseContentItem[] };

/**
 * Course catalog + content items — see docs/conventions/lms.md. `status`
 * (DRAFT -> PUBLISHED -> ARCHIVED) gates catalog visibility:
 * `CourseService.list` forces `status: 'PUBLISHED'` for any caller without
 * `lms.author`, the same "RBAC gates the feature, the service layer gates
 * the row" two-layer shape this codebase takes throughout (see
 * docs/conventions/auth-rbac.md).
 */
@Injectable()
export class CourseService {
  constructor(private readonly categories: CourseCategoryService) {}

  async create(tx: Prisma.TransactionClient, tenantId: string, createdByUserId: string, input: CreateCourseInput): Promise<Course> {
    if (input.categoryId) {
      await this.categories.requireById(tx, tenantId, input.categoryId);
    }
    return tx.course.create({
      data: {
        tenantId,
        categoryId: input.categoryId ?? null,
        title: input.title,
        description: input.description ?? null,
        isMandatory: input.isMandatory ?? false,
        validityMonths: input.validityMonths ?? null,
        createdByUserId,
      },
    });
  }

  async update(tx: Prisma.TransactionClient, tenantId: string, id: string, input: UpdateCourseInput): Promise<Course> {
    await this.requireById(tx, tenantId, id);
    if (input.categoryId) {
      await this.categories.requireById(tx, tenantId, input.categoryId);
    }
    return tx.course.update({
      where: { id },
      data: {
        categoryId: input.categoryId,
        title: input.title,
        description: input.description,
        isMandatory: input.isMandatory,
        validityMonths: input.validityMonths,
      },
    });
  }

  async publish(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<Course> {
    const course = await this.requireById(tx, tenantId, id);
    if (course.status !== 'DRAFT') {
      throw new ConflictException(`Course "${id}" is "${course.status}" and cannot be published from that state.`);
    }
    const contentCount = await tx.courseContentItem.count({ where: { tenantId, courseId: id } });
    if (contentCount === 0) {
      throw new ConflictException('A course needs at least one content item before it can be published.');
    }
    return tx.course.update({ where: { id }, data: { status: 'PUBLISHED', publishedAt: new Date() } });
  }

  async archive(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<Course> {
    await this.requireById(tx, tenantId, id);
    return tx.course.update({ where: { id }, data: { status: 'ARCHIVED' } });
  }

  async list(
    tx: Prisma.TransactionClient,
    tenantId: string,
    canAuthor: boolean,
    filters: { status?: string; categoryId?: string },
  ): Promise<Course[]> {
    const where: Prisma.CourseWhereInput = { tenantId };
    if (!canAuthor) {
      where.status = 'PUBLISHED';
    } else if (filters.status) {
      where.status = filters.status as Course['status'];
    }
    if (filters.categoryId) {
      where.categoryId = filters.categoryId;
    }
    return tx.course.findMany({ where, orderBy: { createdAt: 'desc' } });
  }

  async findById(tx: Prisma.TransactionClient, tenantId: string, id: string, canAuthor: boolean): Promise<CourseWithContent> {
    const course = await tx.course.findFirst({
      where: { tenantId, id },
      include: { contentItems: { orderBy: { orderIndex: 'asc' } } },
    });
    if (!course || (!canAuthor && course.status !== 'PUBLISHED')) {
      throw new NotFoundException(`Course "${id}" was not found.`);
    }
    return course;
  }

  async requireById(tx: Prisma.TransactionClient, tenantId: string, id: string): Promise<Course> {
    const course = await tx.course.findFirst({ where: { tenantId, id } });
    if (!course) {
      throw new NotFoundException(`Course "${id}" was not found.`);
    }
    return course;
  }

  async addContentItem(
    tx: Prisma.TransactionClient,
    tenantId: string,
    courseId: string,
    input: CreateContentItemInput,
  ): Promise<CourseContentItem> {
    await this.requireById(tx, tenantId, courseId);
    return tx.courseContentItem.create({
      data: {
        tenantId,
        courseId,
        moduleName: input.moduleName ?? null,
        orderIndex: input.orderIndex,
        type: input.type,
        title: input.title,
        externalUrl: input.externalUrl ?? null,
        durationMinutes: input.durationMinutes ?? null,
      },
    });
  }

  async setContentItemStorageKey(
    tx: Prisma.TransactionClient,
    tenantId: string,
    courseId: string,
    itemId: string,
    storageKey: string,
  ): Promise<CourseContentItem> {
    const item = await this.requireContentItem(tx, tenantId, courseId, itemId);
    if (item.type === 'LINK') {
      throw new ConflictException('A LINK content item cannot have an uploaded file — edit its externalUrl instead.');
    }
    return tx.courseContentItem.update({ where: { id: item.id }, data: { storageKey } });
  }

  async requireContentItem(tx: Prisma.TransactionClient, tenantId: string, courseId: string, itemId: string): Promise<CourseContentItem> {
    const item = await tx.courseContentItem.findFirst({ where: { tenantId, id: itemId, courseId } });
    if (!item) {
      throw new NotFoundException(`Content item "${itemId}" was not found on course "${courseId}".`);
    }
    return item;
  }

  async removeContentItem(tx: Prisma.TransactionClient, tenantId: string, courseId: string, itemId: string): Promise<void> {
    const item = await this.requireContentItem(tx, tenantId, courseId, itemId);
    await tx.courseContentItem.delete({ where: { id: item.id } });
  }
}
