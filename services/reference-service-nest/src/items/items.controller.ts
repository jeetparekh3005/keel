import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Scopes, ZodValidationPipe } from '@keel/core';
import { z } from 'zod';

import { type Item } from './item.js';
import { ItemService } from './item.service.js';

const createItemSchema = z.object({ name: z.string().min(1).max(200) });

interface ItemOut {
  id: string;
  name: string;
}

interface ItemListOut {
  items: ItemOut[];
  limit: number;
  offset: number;
  count: number;
}

function itemOut(item: Item): ItemOut {
  return { id: item.id, name: item.name };
}

/**
 * The items aggregate routes. Each declares its required scope; the global deny-by-default
 * guard enforces authentication and the scope before the handler runs.
 */
@Controller('v1/items')
export class ItemsController {
  constructor(private readonly items: ItemService) {}

  @Post()
  @Scopes('items:write')
  @HttpCode(201)
  async create(
    @Body(new ZodValidationPipe(createItemSchema)) body: { name: string },
  ): Promise<ItemOut> {
    return itemOut(await this.items.create(body.name));
  }

  @Get()
  @Scopes('items:read')
  async list(
    @Query('limit') limitParam?: string,
    @Query('offset') offsetParam?: string,
  ): Promise<ItemListOut> {
    const limit = clamp(parseIntOr(limitParam, 50), 1, 200);
    const offset = Math.max(parseIntOr(offsetParam, 0), 0);
    const items = await this.items.list(limit, offset);
    return { items: items.map(itemOut), limit, offset, count: items.length };
  }

  @Get(':id')
  @Scopes('items:read')
  async get(@Param('id') id: string): Promise<ItemOut> {
    return itemOut(await this.items.get(id));
  }
}

function parseIntOr(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(value, hi));
}
