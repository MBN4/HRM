import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';

/**
 * Validates a request body against a zod schema from `@hrm/shared`
 * (`packages/shared/src/validators/*`) — the project's one validation
 * paradigm end to end (client, DTOs, and here), rather than introducing
 * class-validator as a second one alongside it.
 *
 * Usage: `@Body(new ZodValidationPipe(loginSchema)) body: LoginInput`.
 */
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown) {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })));
    }
    return result.data;
  }
}
