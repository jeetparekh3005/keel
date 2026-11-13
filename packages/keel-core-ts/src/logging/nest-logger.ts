// A NestJS LoggerService that forwards Nest's own framework/bootstrap logs through the shared
// redacting pino logger, so the startup lines Nest emits (NestFactory, routes mapped, app
// started) are structured JSON with the same secret redaction as app/error code - instead of
// the default colorized ConsoleLogger. Wire it in main.ts with
// `NestFactory.create(AppModule, { bufferLogs: true })` + `app.useLogger(createNestLogger(level))`.
import type { LoggerService } from '@nestjs/common';
import type { DestinationStream, Logger } from 'pino';

import { createLogger } from './logger.js';

// Nest's log levels mapped onto pino's. `verbose` is the chattiest Nest level, so it maps to
// pino `trace`; the rest line up by name.
type PinoLevel = 'info' | 'error' | 'warn' | 'debug' | 'trace' | 'fatal';

/**
 * Adapts the redacting pino logger to NestJS's LoggerService so framework logs flow through the
 * same JSON sink and redaction as the rest of the vertical. Nest's calling convention is
 * `method(message, ...optionalParams)` where the trailing string is the logging context (e.g.
 * 'NestApplication') and, for `error`, a leading param may be a stack. The context and any extra
 * params travel as merge fields so pino's redaction scrubs them too; the message is scrubbed as
 * the log line.
 */
export class NestLoggerAdapter implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('trace', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', message, optionalParams);
  }

  private write(level: PinoLevel, message: unknown, optionalParams: unknown[]): void {
    const bindings: Record<string, unknown> = {};
    let params = optionalParams;
    // Nest puts the logging context as the trailing string argument.
    if (params.length > 0 && typeof params[params.length - 1] === 'string') {
      bindings.context = params[params.length - 1];
      params = params.slice(0, -1);
    }
    // Anything left (e.g. an error stack/object) travels under `details` so it is redacted too.
    if (params.length === 1) {
      bindings.details = params[0];
    } else if (params.length > 1) {
      bindings.details = params;
    }

    if (typeof message === 'string') {
      if (Object.keys(bindings).length > 0) {
        this.logger[level](bindings, message);
      } else {
        this.logger[level](message);
      }
    } else {
      // A non-string message (object/Error) is logged as a merge field; pino's redaction
      // descends into it (and preserves an Error's message/stack).
      this.logger[level]({ ...bindings, message });
    }
  }
}

/**
 * Build a NestLoggerAdapter backed by a fresh redacting pino logger at the given level. An
 * optional destination stream is accepted so tests can capture output; production omits it
 * (pino writes to stdout).
 */
export function createNestLogger(
  level: string,
  destination?: DestinationStream,
): NestLoggerAdapter {
  return new NestLoggerAdapter(createLogger(level, destination));
}
