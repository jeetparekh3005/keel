import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Database, DATABASE } from '@keel/core';

import { loadServiceConfig, SERVICE_CONFIG, type ServiceConfig } from './config.js';

/**
 * Service infrastructure: the loaded config and the Postgres connection pool, provided
 * globally so the composition root and the repository can inject them. The pool is opened
 * fail-fast at startup (Database.connect verifies connectivity) and closed on shutdown.
 */
@Global()
@Module({
  providers: [
    { provide: SERVICE_CONFIG, useFactory: () => loadServiceConfig() },
    {
      provide: DATABASE,
      useFactory: (config: ServiceConfig) => Database.connect(config.DATABASE_URL),
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
