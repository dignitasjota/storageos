import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';

import { SecurityEventsService } from '../../modules/security-events/security-events.service';

import type { ExecutionContext } from '@nestjs/common';
import type { SecurityEventType } from '@storageos/database';
import type { Request } from 'express';

/**
 * `ThrottlerGuard` extendido que, ademas de cortar el request, deja traza en
 * `security_events` cuando el endpoint throttleado es uno sensible de auth.
 * Asi las alertas brute-force (`SecurityAlertsService`) y el panel
 * `/admin/security-events` ven tambien los picos de rate-limit, no solo los
 * passwords erroneos.
 *
 * Sustituye al `ThrottlerGuard` base en el primer `APP_GUARD` (mismo orden
 * Throttler -> JwtAuth -> Roles); no cambia el comportamiento de corte, solo
 * lo instrumenta. En tests el throttler aplica `skipIf: () => true`, por lo
 * que `throwThrottlingException` nunca se invoca y este guard es transparente.
 */
@Injectable()
export class SecurityThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly securityEvents: SecurityEventsService,
  ) {
    super(options, storageService, reflector);
  }

  protected override async throwThrottlingException(
    context: ExecutionContext,
    throttlerLimitDetail: ThrottlerLimitDetail,
  ): Promise<void> {
    const eventType = this.resolveSecurityEventType(context);
    if (eventType) {
      const req = context.switchToHttp().getRequest<Request>();
      const bodyEmail = (req.body as { email?: unknown } | undefined)?.email;
      await this.securityEvents.record({
        eventType,
        emailAttempted: typeof bodyEmail === 'string' ? bodyEmail : null,
        ipAddress: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        reason: 'rate_limited',
      });
    }
    return super.throwThrottlingException(context, throttlerLimitDetail);
  }

  /**
   * Mapea la ruta throttleada a un `SecurityEventType`. Devuelve `null` para
   * endpoints no sensibles (no queremos persistir el throttle de cualquier
   * GET). El match es por substring de la ruta para tolerar el prefijo de
   * versionado `/v1/` y el redirect legacy.
   */
  private resolveSecurityEventType(context: ExecutionContext): SecurityEventType | null {
    const req = context.switchToHttp().getRequest<Request & { route?: { path?: string } }>();
    const path = req.route?.path ?? req.path ?? req.url ?? '';
    if (path.includes('/auth/login') || path.includes('/auth/2fa/challenge')) {
      return 'login_failed_throttled';
    }
    if (path.includes('/auth/register')) {
      return 'register_throttled';
    }
    if (path.includes('/auth/password/forgot') || path.includes('/auth/password/reset')) {
      return 'password_reset_throttled';
    }
    return null;
  }
}
