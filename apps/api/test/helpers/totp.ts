import { Secret, TOTP } from 'otpauth';

/** Genera el codigo TOTP actual para un secret base32 (mismo algoritmo que el backend). */
export function generateTotpCode(secretBase32: string, atSeconds?: number): string {
  const totp = new TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  });
  if (atSeconds !== undefined) {
    return totp.generate({ timestamp: atSeconds * 1000 });
  }
  return totp.generate();
}
