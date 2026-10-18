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
 *   - en solo lectura, solo se admiten peticiones de lectura.
 */
const ACCOUNT_PATHS = /^\/(?:v\d+\/)?(?:me(?:\/|$)|auth\/2fa\/|auth\/logout-all)/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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
        message: 'Durante una impersonación no se cambian los datos de acceso de la cuenta',
      });
    }
    if (impersonation.readOnly && !SAFE_METHODS.has(req.method)) {
      throw new ForbiddenException({
        code: 'impersonation_read_only',
        message: 'Sesión de soporte en solo lectura: no se pueden hacer cambios',
      });
    }
    return true;
  }
}
