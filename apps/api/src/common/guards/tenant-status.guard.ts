import { CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

import { PrismaAdminService } from '../../modules/database/prisma-admin.service';

import type { AuthenticatedUser } from '../decorators/current-user.decorator';

/** TTL de la caché en memoria del estado del tenant (ms). */
const TENANT_STATUS_TTL_MS = 60_000;

/**
 * Revalida por request que el tenant del token de staff sigue vivo. Sin esto,
 * el access token (TTL 15 min) seguía operando hasta 15 min tras BORRAR/anonimizar
 * el tenant (`deletedAt`) — un ex-tenant seguía leyendo/escribiendo datos.
 *
 * Bloquea SOLO `deletedAt != null` (borrado/cancelado-anonimizado), que es
 * exactamente lo que bloquea el login/refresh (`AuthService`): coherente y sin
 * romper el flujo de un tenant `suspended` (que SÍ puede seguir operando para
 * pagar y reactivarse — pay-to-reactivate).
 *
 * El lookup a BD se cachea en memoria por tenant (TTL corto) para no golpear la
 * base en cada request; un tenant borrado deja de operar en ≤ TTL (60 s) en vez
 * de esperar a que expire su token. Patrón idéntico al del CORS dinámico
 * (`cors-origin.ts`).
 *
 * Se evalúa DESPUÉS del `JwtAuthGuard` (necesita `request.user`). Sin
 * `request.user` (rutas públicas, admin, API key) deja pasar.
 */
@Injectable()
export class TenantStatusGuard implements CanActivate {
  /** tenantId → { alive, exp }. Singleton: la caché persiste entre requests. */
  private readonly cache = new Map<string, { alive: boolean; exp: number }>();

  constructor(private readonly admin: PrismaAdminService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const tenantId = request.user?.tenantId;
    if (!tenantId) return true; // rutas públicas / admin / API key: sin tenant de staff

    const now = Date.now();
    const cached = this.cache.get(tenantId);
    const alive = cached && cached.exp > now ? cached.alive : await this.refresh(tenantId, now);
    if (!alive) {
      throw new ForbiddenException({
        code: 'tenant_unavailable',
        message: 'La cuenta ya no está disponible',
      });
    }
    return true;
  }

  private async refresh(tenantId: string, now: number): Promise<boolean> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { deletedAt: true },
    });
    const alive = !!tenant && tenant.deletedAt === null;
    this.cache.set(tenantId, { alive, exp: now + TENANT_STATUS_TTL_MS });
    return alive;
  }
}
