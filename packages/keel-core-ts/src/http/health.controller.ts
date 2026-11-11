import { Controller, Get, Inject } from '@nestjs/common';

import { DomainError, ErrorCategory } from '../domain/errors.js';
import { Public } from '../auth/scopes.decorator.js';
import { READINESS, type ReadinessCheck } from './tokens.js';

/**
 * Liveness and readiness probes (platform.yaml health). Public (exempt from the deny-by-
 * default auth guard): /healthz is always 200 if the process is up; /readyz is 200 when the
 * readiness check passes and a 503 problem+json when a dependency is unreachable.
 */
@Public()
@Controller()
export class HealthController {
  constructor(@Inject(READINESS) private readonly ready: ReadinessCheck) {}

  @Get('healthz')
  healthz(): { status: string } {
    return { status: 'ok' };
  }

  @Get('readyz')
  async readyz(): Promise<{ status: string }> {
    if (!(await this.ready())) {
      throw new DomainError(ErrorCategory.Unavailable, 'dependencies not ready');
    }
    return { status: 'ready' };
  }
}
