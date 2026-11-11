import { Module } from '@nestjs/common';

import { @< aggregate_upper >@_REPOSITORY } from './@< aggregate >@.js';
import { @< aggregate_pascal >@Service } from './@< aggregate >@.service.js';
import { @< aggregate_pascal_plural >@Controller } from './@< aggregate_plural >@.controller.js';
import { Pg@< aggregate_pascal >@Repository } from './@< aggregate >@.repository.js';

/** Wires the @< aggregate_plural >@ aggregate: the controller and service onto the Postgres repository. */
@Module({
  controllers: [@< aggregate_pascal_plural >@Controller],
  providers: [@< aggregate_pascal >@Service, { provide: @< aggregate_upper >@_REPOSITORY, useClass: Pg@< aggregate_pascal >@Repository }],
})
export class @< aggregate_pascal_plural >@Module {}
