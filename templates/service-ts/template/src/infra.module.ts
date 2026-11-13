import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Database, DATABASE, observeDbPool } from '@keel/core';

import { loadServiceConfig, SERVICE_CONFIG, type ServiceConfig } from './config.js';

/**
 * Service infrastructure: the loaded config and the Postgres connection pool, provided
 * globally so the composition root and the repository can inject them. The pool is opened
 * fail-fast at startup (Database.connect verifies connectivity) and closed on shutdown. On
 * open, its saturation gauges (db.client.connection.*) are registered against the live pool;
 * they report nothing until initTelemetry wires a meter provider.
 */
@Global()
@Module({
  providers: [
    { provide: SERVICE_CONFIG, useFactory: () => loadServiceConfig() },
    {
      provide: DATABASE,
      useFactory: async (config: ServiceConfig) => {
        const database = await Database.connect(config.DATABASE_URL);
        observeDbPool(database);
        return database;
      },
      inject: [SERVICE_CONFIG],
    },
  ],
  exports: [SERVICE_CONFIG, DATABASE],
})
export class InfraModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.close();
  }
}
