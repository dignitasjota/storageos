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
