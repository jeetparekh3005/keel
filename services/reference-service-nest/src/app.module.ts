import { Module } from '@nestjs/common';
import { Database, DATABASE, KeelCoreModule, OidcAuthenticator } from '@keel/core';

import { InfraModule } from './infra.module.js';
import { ItemsModule } from './items/items.module.js';
import { REFERENCE_CONFIG, type ReferenceConfig } from './config.js';

/**
 * The composition root: the core platform module (wired with the real OIDC authenticator and
 * a DB-ping readiness check, built from injected config and the pool) plus the items
 * aggregate. The driving adapter (the controller) never imports the concrete repository; the
 * wiring lives here.
 */
@Module({
  imports: [
    InfraModule,
    KeelCoreModule.forRootAsync({
      imports: [InfraModule],
      inject: [REFERENCE_CONFIG, DATABASE],
      useFactory: (config: ReferenceConfig, db: Database) => ({
        logLevel: config.LOG_LEVEL,
        corsAllowOrigins: config.CORS_ALLOW_ORIGINS,
        authenticator: new OidcAuthenticator(
          config.OIDC_ISSUER,
          config.OIDC_AUDIENCE,
          config.OIDC_JWKS_URI,
        ),
        readiness: () => db.ping(),
      }),
    }),
    ItemsModule,
  ],
})
export class AppModule {}
