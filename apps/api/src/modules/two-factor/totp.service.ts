import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Secret, TOTP } from 'otpauth';

import type { Env } from '../../config/env.schema';

/**
 * Servicio TOTP (RFC 6238). Algoritmo SHA1, 6 digitos, periodo 30s, que es
 * el estandar que aceptan Google Authenticator, Authy, 1Password, etc.
 *
 * Ventana de validacion ±1 (codigo actual + el anterior y el siguiente) para
 * tolerar drift de reloj del cliente. Otros codigos: rechazo limpio.
 *
 * Los secretos se generan aqui y se devuelven en base32. La capa de
 * almacenamiento es responsable de cifrarlos antes de persistir (CryptoService).
 */
@Injectable()
export class TotpService {
  private readonly issuer: string;

  constructor(config: ConfigService<Env, true>) {
    // Mostrar "TrasterOS" como issuer en la app del autenticador.
    this.issuer = config.get('SMTP_FROM_NAME', { infer: true }) || 'TrasterOS';
  }

  /** Devuelve un nuevo secret base32 (160 bits, longitud estandar). */
  generateSecret(): string {
    return new Secret({ size: 20 }).base32;
  }

  /**
   * Construye el URI otpauth:// que el frontend usara para renderizar el QR.
   * El label sigue la convencion `Issuer:account` recomendada por Google.
   */
  buildOtpAuthUri(secretBase32: string, accountEmail: string): string {
    const totp = new TOTP({
      issuer: this.issuer,
      label: accountEmail,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(secretBase32),
    });
    return totp.toString();
  }

  /** Valida un codigo TOTP de 6 digitos contra el secret. Ventana ±1. */
  verify(secretBase32: string, code: string): boolean {
    const normalized = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(normalized)) return false;
    const totp = new TOTP({
      issuer: this.issuer,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(secretBase32),
    });
    // `validate` devuelve el delta de ventana o null. ±1 cubre ~30s de drift.
    const delta = totp.validate({ token: normalized, window: 1 });
    return delta !== null;
  }

  /**
   * Como `verify`, pero devuelve el PASO de 30 s con el que casó el código
   * (o `null`). Permite el anti-replay: guardar el último paso aceptado y
   * rechazar un código de un paso igual o anterior aunque siga en la ventana.
   */
  matchStep(secretBase32: string, code: string, now: number = Date.now()): number | null {
    const normalized = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(normalized)) return null;
    const totp = new TOTP({
      issuer: this.issuer,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(secretBase32),
    });
    const delta = totp.validate({ token: normalized, window: 1, timestamp: now });
    if (delta === null) return null;
    return Math.floor(now / 1000 / 30) + delta;
  }
}
