import { SetMetadata } from '@nestjs/common';

/** Key de metadata para marcar handlers/clases como publicos. */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marca un handler (o un controller entero) como publico: el `JwtAuthGuard`
 * global lo salta. Util para `/auth/register`, `/auth/login`, `/auth/refresh`
 * y endpoints de salud.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
