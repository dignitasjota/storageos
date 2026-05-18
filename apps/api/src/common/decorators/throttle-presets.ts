import { applyDecorators } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

/**
 * Presets de rate limiting para endpoints sensibles. Cada uno sobreescribe
 * el throttler global "default" (60/min) con valores apropiados.
 *
 * Hardcodeados a proposito: cambiarlos exige revisar tambien los tests e2e
 * y las expectativas de UX (cuanto tarda en bloquearse un usuario tras N
 * intentos). Si en algun momento queremos tunearlos por env, lo migramos
 * a un guard custom que lea ConfigService.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const ThrottleLogin = () =>
  applyDecorators(Throttle({ default: { limit: 5, ttl: MINUTE } }));

export const ThrottleRegister = () =>
  applyDecorators(Throttle({ default: { limit: 3, ttl: HOUR } }));

export const ThrottleRefresh = () =>
  applyDecorators(Throttle({ default: { limit: 30, ttl: MINUTE } }));
