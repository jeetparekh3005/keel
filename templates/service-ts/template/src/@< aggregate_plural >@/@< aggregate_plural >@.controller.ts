import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Scopes, ZodValidationPipe } from '@keel/core';
import { z } from 'zod';

import { type @< aggregate_pascal >@ } from './@< aggregate >@.js';
import { @< aggregate_pascal >@Service } from './@< aggregate >@.service.js';

const create@< aggregate_pascal >@Schema = z.object({ name: z.string().min(1).max(200) });

interface @< aggregate_pascal >@Out {
  id: string;
  name: string;
}

interface @< aggregate_pascal >@ListOut {
  @< aggregate_plural >@: @< aggregate_pascal >@Out[];
  limit: number;
  offset: number;
  count: number;
}

function @< aggregate >@Out(@< aggregate >@: @< aggregate_pascal >@): @< aggregate_pascal >@Out {
  return { id: @< aggregate >@.id, name: @< aggregate >@.name };
}

/**
 * The @< aggregate_plural >@ aggregate routes. Each declares its required scope; the global deny-by-default
 * guard enforces authentication and the scope before the handler runs.
 */
@Controller('v1/@< aggregate_plural >@')
export class @< aggregate_pascal_plural >@Controller {
  constructor(private readonly @< aggregate_plural >@: @< aggregate_pascal >@Service) {}

  @Post()
  @Scopes('@< scope_prefix >@:write')
  @HttpCode(201)
  async create(
    @Body(new ZodValidationPipe(create@< aggregate_pascal >@Schema)) body: { name: string },
  ): Promise<@< aggregate_pascal >@Out> {
    return @< aggregate >@Out(await this.@< aggregate_plural >@.create(body.name));
  }

  @Get()
  @Scopes('@< scope_prefix >@:read')
  async list(
    @Query('limit') limitParam?: string,
    @Query('offset') offsetParam?: string,
  ): Promise<@< aggregate_pascal >@ListOut> {
    const limit = clamp(parseIntOr(limitParam, 50), 1, 200);
    const offset = Math.max(parseIntOr(offsetParam, 0), 0);
    const @< aggregate_plural >@ = await this.@< aggregate_plural >@.list(limit, offset);
    return { @< aggregate_plural >@: @< aggregate_plural >@.map(@< aggregate >@Out), limit, offset, count: @< aggregate_plural >@.length };
  }

  @Get(':id')
  @Scopes('@< scope_prefix >@:read')
  async get(@Param('id') id: string): Promise<@< aggregate_pascal >@Out> {
    return @< aggregate >@Out(await this.@< aggregate_plural >@.get(id));
  }
}

function parseIntOr(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(value, hi));
}
