import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, Quiz, QuizAttempt, QuizQuestion } from '@hrm/db';
import { CreateQuizQuestionInput, SubmitQuizAttemptInput, UpsertQuizInput } from '@hrm/shared';
import { EnrollmentService } from './enrollment.service';

export type QuestionForTaking = Omit<QuizQuestion, 'correctOptionKey'>;

/**
 * Quizzes/assessments — CONFIGURABLE AS DATA (questions, pass mark), never
 * hardcoded scoring logic, per this step's brief. `correctOptionKey` is
 * stripped before a question ever reaches a caller taking the quiz
 * (`listQuestionsForTaking`) — a plain, manual field omission (this module
 * has no salary-like field-gating precedent worth reusing
 * `@RequiresPermission()` for a single field on one DTO shape).
 */
@Injectable()
export class QuizService {
  constructor(private readonly enrollments: EnrollmentService) {}

  async upsertQuiz(tx: Prisma.TransactionClient, tenantId: string, courseId: string, input: UpsertQuizInput): Promise<Quiz> {
    await this.requireCourse(tx, tenantId, courseId);
    return tx.quiz.upsert({
      where: { tenantId_courseId: { tenantId, courseId } },
      update: { title: input.title, passMarkPercent: input.passMarkPercent, isRequired: input.isRequired },
      create: {
        tenantId,
        courseId,
        title: input.title,
        passMarkPercent: input.passMarkPercent ?? 70,
        isRequired: input.isRequired ?? true,
      },
    });
  }

  async addQuestion(tx: Prisma.TransactionClient, tenantId: string, courseId: string, input: CreateQuizQuestionInput): Promise<QuizQuestion> {
    const quiz = await this.requireQuiz(tx, tenantId, courseId);
    return tx.quizQuestion.create({
      data: {
        tenantId,
        quizId: quiz.id,
        orderIndex: input.orderIndex,
        questionText: input.questionText,
        options: input.options,
        correctOptionKey: input.correctOptionKey,
        points: input.points ?? 1,
      },
    });
  }

  async getForAdmin(tx: Prisma.TransactionClient, tenantId: string, courseId: string): Promise<(Quiz & { questions: QuizQuestion[] }) | null> {
    return tx.quiz.findUnique({
      where: { tenantId_courseId: { tenantId, courseId } },
      include: { questions: { orderBy: { orderIndex: 'asc' } } },
    });
  }

  async getForTaking(tx: Prisma.TransactionClient, tenantId: string, courseId: string): Promise<(Quiz & { questions: QuestionForTaking[] }) | null> {
    const quiz = await tx.quiz.findUnique({
      where: { tenantId_courseId: { tenantId, courseId } },
      include: { questions: { orderBy: { orderIndex: 'asc' } } },
    });
    if (!quiz) {
      return null;
    }
    return { ...quiz, questions: quiz.questions.map(({ correctOptionKey: _correctOptionKey, ...rest }) => rest) };
  }

  async submitAttempt(
    tx: Prisma.TransactionClient,
    tenantId: string,
    callerUserId: string,
    enrollmentId: string,
    input: SubmitQuizAttemptInput,
  ): Promise<QuizAttempt> {
    const enrollment = await this.enrollments.findById(tx, tenantId, callerUserId, false, enrollmentId);
    const quiz = await tx.quiz.findUnique({
      where: { tenantId_courseId: { tenantId, courseId: enrollment.courseId } },
      include: { questions: true },
    });
    if (!quiz) {
      throw new NotFoundException('This course has no quiz.');
    }
    if (quiz.questions.length === 0) {
      throw new ConflictException('This quiz has no questions configured yet.');
    }

    const totalPoints = quiz.questions.reduce((sum, question) => sum + question.points, 0);
    const earnedPoints = quiz.questions.reduce(
      (sum, question) => sum + (input.answers[question.id] === question.correctOptionKey ? question.points : 0),
      0,
    );
    const scorePercent = Math.round((earnedPoints / totalPoints) * 100);
    const passed = scorePercent >= quiz.passMarkPercent;

    const attempt = await tx.quizAttempt.create({
      data: {
        tenantId,
        quizId: quiz.id,
        enrollmentId,
        employeeId: enrollment.employeeId,
        scorePercent,
        passed,
        answers: input.answers,
      },
    });

    await this.enrollments.recomputeCompletion(tx, tenantId, enrollmentId);
    return attempt;
  }

  async listAttempts(tx: Prisma.TransactionClient, tenantId: string, enrollmentId: string): Promise<QuizAttempt[]> {
    return tx.quizAttempt.findMany({ where: { tenantId, enrollmentId }, orderBy: { attemptedAt: 'desc' } });
  }

  private async requireCourse(tx: Prisma.TransactionClient, tenantId: string, courseId: string): Promise<void> {
    const course = await tx.course.findFirst({ where: { tenantId, id: courseId } });
    if (!course) {
      throw new NotFoundException(`Course "${courseId}" was not found.`);
    }
  }

  private async requireQuiz(tx: Prisma.TransactionClient, tenantId: string, courseId: string): Promise<Quiz> {
    const quiz = await tx.quiz.findUnique({ where: { tenantId_courseId: { tenantId, courseId } } });
    if (!quiz) {
      throw new BadRequestException(`Course "${courseId}" has no quiz yet — create one via PUT /lms/courses/:id/quiz first.`);
    }
    return quiz;
  }
}
