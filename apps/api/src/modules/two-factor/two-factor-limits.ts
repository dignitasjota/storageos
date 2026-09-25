import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Límite de fallos del segundo factor POR USUARIO (además del throttle por IP).
 * Sin él, un atacante con la contraseña y muchas IPs podía probar códigos de
 * 6 dígitos sin tope. 5 fallos en 15 min bloquean el challenge de ese usuario
 * hasta que salga de la ventana.
 */
export const TWO_FACTOR_MAX_FAILURES = 5;
export const TWO_FACTOR_FAILURE_WINDOW_MS = 15 * 60_000;

export function twoFactorLockedException(): HttpException {
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      code: 'too_many_2fa_attempts',
      message: 'Demasiados códigos incorrectos. Espera unos minutos antes de volver a intentarlo.',
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}
