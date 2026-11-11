import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Inject,
} from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  DomainError,
  ErrorCategory,
  isDomainError,
  type Problem,
  statusFor,
  titleFor,
  typeUriFor,
} from '../domain/errors.js';
import { applySecurityHeaders } from './security-headers.middleware.js';
import { LOGGER, type Logger } from './tokens.js';

const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/**
 * Renders every unhandled error as an RFC 9457 problem+json response. A DomainError maps to
 * its category; a body-limit overflow to 413; a NestJS HttpException to the matching
 * category; anything else to a 500. Server-fault (5xx) detail is logged server-side and
 * dropped from the body, so internals never reach the client. Registered globally (APP_FILTER).
 */
@Catch()
export class ProblemExceptionFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<IncomingMessage>();
    const res = http.getResponse<ServerResponse>();
    const problem = this.toProblem(exception, req.url);

    // The body-limit 413 (and any body-parser error) reaches the filter via Express's error
    // path, bypassing the edge middleware, so set the security headers here too.
    applySecurityHeaders(res);
    res.statusCode = problem.status;
    res.setHeader('Content-Type', PROBLEM_CONTENT_TYPE);
    res.end(JSON.stringify(problem));
  }

  private toProblem(exception: unknown, instance?: string): Problem {
    if (isDomainError(exception)) {
      if (
        exception.category === ErrorCategory.Internal ||
        exception.category === ErrorCategory.Unavailable
      ) {
        this.logger.error(
          { category: exception.category, detail: exception.detail },
          'request failed with a server-side fault',
        );
      }
      return exception.toProblem(instance);
    }

    // express body-parser raises a raw 413 (not a Nest HttpException) when the body limit is
    // exceeded; render it as payload_too_large before the generic HttpException branch.
    const status = numericStatus(exception);
    if (
      status === 413 ||
      (exception as { type?: string } | undefined)?.type === 'entity.too.large'
    ) {
      return withInstance(
        {
          type: 'urn:keel:error:payload_too_large',
          title: 'Payload Too Large',
          status: 413,
        },
        instance,
      );
    }

    if (exception instanceof HttpException) {
      const category = categoryForStatus(exception.getStatus());
      const problem: Problem = {
        type: typeUriFor(category),
        title: titleFor(category),
        status: statusFor(category),
      };
      // Keep a client-fault message; drop server-fault detail (logged below).
      if (!isServerStatus(problem.status)) {
        problem.detail = exception.message;
      } else {
        this.logger.error({ status: problem.status, detail: exception.message }, 'request failed');
      }
      return withInstance(problem, instance);
    }

    // Unknown error: fail closed to 500 and log the real detail server-side only.
    this.logger.error(
      { detail: exception instanceof Error ? exception.message : String(exception) },
      'unhandled error',
    );
    return new DomainError(ErrorCategory.Internal, 'internal error').toProblem(instance);
  }
}

function numericStatus(exception: unknown): number | undefined {
  const value = exception as { status?: unknown; statusCode?: unknown } | undefined;
  const candidate = value?.status ?? value?.statusCode;
  return typeof candidate === 'number' ? candidate : undefined;
}

function isServerStatus(status: number): boolean {
  return status >= 500;
}

function withInstance(problem: Problem, instance?: string): Problem {
  return instance ? { ...problem, instance } : problem;
}

function categoryForStatus(status: number): ErrorCategory {
  switch (status) {
    case 400:
      return ErrorCategory.Validation;
    case 401:
      return ErrorCategory.Unauthenticated;
    case 403:
      return ErrorCategory.Forbidden;
    case 404:
      return ErrorCategory.NotFound;
    case 409:
      return ErrorCategory.Conflict;
    case 429:
      return ErrorCategory.RateLimited;
    case 503:
      return ErrorCategory.Unavailable;
    default:
      return status >= 500 ? ErrorCategory.Internal : ErrorCategory.Validation;
  }
}
