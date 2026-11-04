import { SetMetadata } from '@nestjs/common';

export const REQUIRE_SUPERADMIN_KEY = 'requireSuperadmin';

/**
 * Restringe un endpoint admin al rol `superadmin` (el rol `support` queda
 * fuera). Lo evalúa `AdminGuard` tras verificar el JWT: sin este decorador,
 * cualquier super admin autenticado (superadmin o support) puede llamar.
 *
 * Aplicar a acciones DESTRUCTIVAS (anonimizar), de DINERO (pagos manuales,
 * planes, add-ons) o de SEGURIDAD (impersonar, tocar 2FA/estado de usuarios).
 */
export const RequireSuperadmin = () => SetMetadata(REQUIRE_SUPERADMIN_KEY, true);

export const ALLOW_WITHOUT_TWO_FACTOR_KEY = 'allowWithoutTwoFactor';

/** Rutas que siguen abiertas pasado el plazo de la 2FA obligatoria: las de la propia cuenta. */
export const AllowWithoutTwoFactor = (): ClassDecorator & MethodDecorator =>
  SetMetadata(ALLOW_WITHOUT_TWO_FACTOR_KEY, true);
