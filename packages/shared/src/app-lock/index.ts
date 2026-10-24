import { z } from 'zod';

/**
 * Bloqueo de la app del panel instalada en el móvil: la sesión dura 90 días y,
 * tras unos minutos sin uso, la app se abre con Face ID / huella (llave de
 * acceso) o con un PIN de respaldo.
 */

/** Minutos sin uso tras los que la app instalada se bloquea. */
export const APP_LOCK_IDLE_MINUTES = 15;

/** Intentos de PIN fallidos seguidos antes de cerrar la sesión. */
export const APP_LOCK_MAX_PIN_ATTEMPTS = 5;

const pin = z
  .string()
  .trim()
  .regex(/^\d{4,6}$/, 'El PIN tiene que tener de 4 a 6 cifras');

export const SetAppPinSchema = z.object({ pin });
export type SetAppPinInput = z.infer<typeof SetAppPinSchema>;

export const UnlockWithPinSchema = z.object({ pin });
export type UnlockWithPinInput = z.infer<typeof UnlockWithPinSchema>;

/** Respuesta del navegador a `navigator.credentials.create` (formato JSON de WebAuthn). */
export const RegisterPasskeySchema = z.object({
  response: z.object({ id: z.string().min(1) }).passthrough(),
  label: z.string().trim().min(1).max(60).default('Este dispositivo'),
});
export type RegisterPasskeyInput = z.infer<typeof RegisterPasskeySchema>;

/** Respuesta del navegador a `navigator.credentials.get`. */
export const UnlockWithPasskeySchema = z.object({
  response: z.object({ id: z.string().min(1) }).passthrough(),
});
export type UnlockWithPasskeyInput = z.infer<typeof UnlockWithPasskeySchema>;

export interface AppPasskeyDto {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface AppLockStatusDto {
  pinSet: boolean;
  passkeys: AppPasskeyDto[];
  idleMinutes: number;
}

export interface AppLockUnlockResultDto {
  unlocked: true;
}
