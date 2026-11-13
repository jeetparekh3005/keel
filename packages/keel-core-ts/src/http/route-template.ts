import type { ExecutionContext } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';

/**
 * The matched route template, e.g. `/v1/items/:id`, built from the controller prefix and the
 * handler's method path (Nest stores both under PATH_METADATA on the class and the method). This
 * is the low-cardinality label for span names and metric attributes - unlike `request.url`, which
 * carries per-request id values. Falls back to `/` when no path metadata is present.
 */
export function routeTemplate(executionContext: ExecutionContext): string {
  const controllerPath = firstPath(
    Reflect.getMetadata(PATH_METADATA, executionContext.getClass()) as unknown,
  );
  const handlerPath = firstPath(
    Reflect.getMetadata(PATH_METADATA, executionContext.getHandler()) as unknown,
  );
  const segments = [controllerPath, handlerPath]
    .map((segment) => segment.replace(/^\/+|\/+$/g, ''))
    .filter((segment) => segment.length > 0);
  return `/${segments.join('/')}`;
}

/** Nest allows a path to be a string or an array of strings; take the first for the label. */
function firstPath(value: unknown): string {
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : '';
  }
  return typeof value === 'string' ? value : '';
}
