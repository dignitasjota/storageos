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

export const SALES_ACCESS_KEY = 'salesAccess';

/**
 * Rutas a las que llega el rol `sales` (comercial). El resto del panel le está
 * cerrado por defecto: `AdminGuard` le responde 403 `sales_not_allowed` en todo
 * lo que no lleve esta marca, así ninguna pantalla nueva queda expuesta por
 * descuido.
 */
export const SalesAccess = (): ClassDecorator & MethodDecorator =>
  SetMetadata(SALES_ACCESS_KEY, true);
