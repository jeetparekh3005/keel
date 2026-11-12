// The reference service entrypoint: load config, start telemetry, wire real adapters
// (Postgres + OIDC/JWKS via AppModule), serve the composed app with a bounded body size, and
// shut down gracefully on SIGTERM/SIGINT.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createNestLogger, initTelemetry } from '@keel/core';

import { AppModule } from './app.module.js';
import { loadServiceConfig } from './config.js';

async function bootstrap(): Promise<void> {
  const config = loadServiceConfig();

  const shutdownTelemetry = initTelemetry({
    serviceName: config.SERVICE_NAME,
    version: config.VERSION,
    environment: config.ENVIRONMENT,
    otlpEndpoint: config.OTLP_ENDPOINT || undefined,
  });

  // Disable Nest's default body parser so we can set an explicit size limit; an over-limit
  // body then raises a 413 that the core exception filter renders as problem+json. Buffer the
  // framework's own startup logs until useLogger swaps in the redacting pino logger, so every
  // bootstrap line is emitted as redacted JSON (consistent with app/error logging).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    bufferLogs: true,
  });
  app.useLogger(createNestLogger(config.LOG_LEVEL));
  app.useBodyParser('json', { limit: config.MAX_BODY_BYTES });
  app.enableShutdownHooks();

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    // app.close drains in-flight requests and closes the DB pool (InfraModule shutdown hook).
    await app.close();
    await shutdownTelemetry();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  await app.listen(config.PORT, '0.0.0.0');
}

void bootstrap();
