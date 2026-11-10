import { Injectable, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

import { DomainError, ErrorCategory } from '../domain/errors.js';

/**
 * Validates and parses a request payload against a zod schema. A schema violation becomes a
 * Validation DomainError (400 problem+json), so request validation uses the same typed,
 * explicit schema machinery as config, rather than decorator reflection.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: z.ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const detail = result.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
      throw new DomainError(ErrorCategory.Validation, detail);
    }
    return result.data;
  }
}
