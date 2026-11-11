import { CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../decorators/current-user.decorator';

/**
 * Pantallas de toda la empresa (remesas SEPA, conciliación bancaria): la
 * remesa y el extracto mezclan dinero de todos los locales, así que solo las
 * usa quien ve todos. Un usuario restringido a algunos locales recibe 403
 * `company_wide_only`.
 */
@Injectable()
export class CompanyWideGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    if (Array.isArray(request.user?.facilityScope)) {
      throw new ForbiddenException({
        code: 'company_wide_only',
        message: 'Esta pantalla es de toda la empresa: solo la usan quienes ven todos los locales.',
      });
    }
    return true;
  }
}
