import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

import type { AuthenticatedUser } from '../decorators/current-user.decorator';
import type { Request } from 'express';

/**
 * Límites de una sesión de impersonación del soporte de TrasterOS (va tras
 * `JwtAuthGuard`, que pone `request.user`):
 *
 *   - nunca se tocan los datos de acceso de la persona en cuyo nombre se entra
 *     (perfil, contraseña, 2FA, avisos, cerrar todas sus sesiones);
 *   - nunca se crean accesos que duren más que la sesión de soporte: traspasar
 *     la propiedad, invitar usuarios, claves de API, webhooks, quitar el 2FA
 *     de alguien ni enlaces de acceso al área de clientes;
 *   - en solo lectura, solo se admiten peticiones de lectura.
 */
const ACCOUNT_PATHS = new RegExp(
  '^/(?:v\\d+/)?(?:' +
    [
      'me(?:/|$)',
      'auth/2fa/',
      'auth/logout-all',
      'users/[^/]+/(?:transfer-ownership|disable-2fa)',
      'invitations(?:/|$)',
      'settings/api-keys(?:/|$)',
      'settings/webhooks(?:/[^/]+)?(?:/rotate-secret)?/?$',
      'customers/[^/]+/portal-link(?:/|$)',
      'customers/bulk/portal-access',
    ].join('|') +
    ')',
);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/**
 * Escrituras que durante una impersonación no hacen nada (el controlador no
 * toca los datos de la persona suplantada): se admiten también en solo lectura
 * para que el panel no reciba un error al abrirlas.
 */
const NOOP_WHILE_IMPERSONATING = /^\/(?:v\d+\/)?product-updates\/seen\/?$/;

@Injectable()
export class ImpersonationGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const impersonation = req.user?.impersonation;
    if (!impersonation) return true;

    const path = (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';
    if (!SAFE_METHODS.has(req.method) && ACCOUNT_PATHS.test(path)) {
      throw new ForbiddenException({
        code: 'not_allowed_while_impersonating',
        message:
          'Durante una sesión de soporte no se cambian los datos de acceso ni se crean accesos (usuarios, claves de API, webhooks o enlaces del área de clientes).',
      });
    }
    if (
      impersonation.readOnly &&
      !SAFE_METHODS.has(req.method) &&
      !NOOP_WHILE_IMPERSONATING.test(path)
    ) {
      throw new ForbiddenException({
        code: 'impersonation_read_only',
        message: 'Sesión de soporte en solo lectura: no se pueden hacer cambios',
      });
    }
    return true;
  }
}
