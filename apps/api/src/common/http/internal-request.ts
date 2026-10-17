import { timingSafeEqual } from 'node:crypto';

import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * ¿La petición viene del servidor del web (páginas públicas, metadatos,
 * middleware) con el secreto compartido `INTERNAL_API_TOKEN`? Esas llamadas
 * salen todas de la misma IP y no deben contar en los límites por IP.
 */
export function isInternalWebRequest(
  context: ExecutionContext,
  token: string | undefined,
): boolean {
  if (!token || context.getType() !== 'http') return false;
  const req = context.switchToHttp().getRequest<Request>();
  const sent = req.headers['x-internal-token'];
  if (typeof sent !== 'string' || sent.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(sent), Buffer.from(token));
}
