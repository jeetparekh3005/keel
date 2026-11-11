import { Module } from '@nestjs/common';

import { ITEM_REPOSITORY } from './item.js';
import { ItemService } from './item.service.js';
import { ItemsController } from './items.controller.js';
import { PgItemRepository } from './item.repository.js';

/** Wires the items aggregate: the controller and service onto the Postgres repository. */
@Module({
  controllers: [ItemsController],
  providers: [ItemService, { provide: ITEM_REPOSITORY, useClass: PgItemRepository }],
})
export class ItemsModule {}
