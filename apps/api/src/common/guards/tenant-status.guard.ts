import { CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

import { PrismaAdminService } from '../../modules/database/prisma-admin.service';

import type { AuthenticatedUser } from '../decorators/current-user.decorator';
import type { Request } from 'express';

/** TTL de la caché en memoria del estado del tenant (ms). En los e2e, sin caché. */
const TENANT_STATUS_TTL_MS = process.env.NODE_ENV === 'test' ? 0 : 60_000;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Lo que un tenant suspendido sí puede cambiar: pagar y regularizar su
 * suscripción (Checkout, portal de Stripe, datos de facturación, mandato
 * SEPA, extras), pedir ayuda a soporte, su propia cuenta y marcar avisos
 * como leídos. Todo lo demás queda en solo lectura.
 */
const SUSPENDED_WRITABLE_PATHS =
  /^\/(?:v\d+\/)?(?:settings\/saas-billing(?:\/|$)|support\/tickets(?:\/|$)|me(?:\/|$)|auth\/|notifications(?:\/|$)|product-updates\/seen)/;

type TenantState = 'alive' | 'suspended' | 'gone';

/**
 * Revalida por request el estado del tenant del token de staff:
 *
 *   - borrado/anonimizado (`deletedAt`) → 403 `tenant_unavailable` (lo mismo
 *     que bloquean el login y el refresh); sin esto el access token seguía
 *     operando hasta 15 min;
 *   - suspendido (impago de la suscripción o a mano) → **solo lectura**: puede
 *     verlo todo, pagar y reactivarse (pay-to-reactivate), pero cualquier otra
 *     escritura da 403 `tenant_suspended_read_only`. Sus inquilinos tampoco
 *     pueden usar el área de clientes (`PortalService`). Al registrarse el pago
 *     (Stripe, remesa SEPA o pago manual) el tenant vuelve a `active` solo.
 *
 * El lookup a BD se cachea en memoria por tenant (TTL corto): un cambio de
 * estado se nota en ≤ 60 s.
 *
 * Se evalúa DESPUÉS del `JwtAuthGuard` (necesita `request.user`). Sin
 * `request.user` (rutas públicas, admin, API key) deja pasar.
 */
@Injectable()
export class TenantStatusGuard implements CanActivate {
  /** tenantId → { state, exp }. Singleton: la caché persiste entre requests. */
  private readonly cache = new Map<string, { state: TenantState; exp: number }>();

  constructor(private readonly admin: PrismaAdminService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const tenantId = request.user?.tenantId;
    if (!tenantId) return true; // rutas públicas / admin / API key: sin tenant de staff

    const now = Date.now();
    const cached = this.cache.get(tenantId);
    const state = cached && cached.exp > now ? cached.state : await this.refresh(tenantId, now);
    if (state === 'gone') {
      throw new ForbiddenException({
        code: 'tenant_unavailable',
        message: 'La cuenta ya no está disponible',
      });
    }
    if (state === 'suspended' && !SAFE_METHODS.has(request.method)) {
      const path = (request.originalUrl ?? request.url ?? '').split('?')[0] ?? '';
      if (!SUSPENDED_WRITABLE_PATHS.test(path)) {
        throw new ForbiddenException({
          code: 'tenant_suspended_read_only',
          message:
            'Tu cuenta está suspendida por un pago pendiente: solo puedes consultar. Regulariza el pago en Configuración → Suscripción para volver a trabajar.',
        });
      }
    }
    return true;
  }

  private async refresh(tenantId: string, now: number): Promise<TenantState> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { deletedAt: true, status: true },
    });
    const state: TenantState =
      !tenant || tenant.deletedAt ? 'gone' : tenant.status === 'suspended' ? 'suspended' : 'alive';
    this.cache.set(tenantId, { state, exp: now + TENANT_STATUS_TTL_MS });
    return state;
  }
}
