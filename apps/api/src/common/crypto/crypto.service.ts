import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env.schema';

/**
 * Cifrado simetrico para secrets sensibles guardados en BD (TOTP secret de
 * 2FA). AES-256-GCM con `MASTER_ENCRYPTION_KEY` (32 bytes en base64).
 *
 * Formato del ciphertext (todo en base64url, separado por puntos):
 *   `<iv>.<authTag>.<encrypted>`
 *
 * Nunca se loguea ni el plaintext ni el key. El RLS protege la fila a nivel
 * de BD; el cifrado anyade defensa en profundidad ante dumps o backups.
 */
@Injectable()
export class CryptoService {
  private readonly key: Buffer;

  constructor(config: ConfigService<Env, true>) {
    const b64 = config.get('MASTER_ENCRYPTION_KEY', { infer: true });
    this.key = Buffer.from(b64, 'base64');
    if (this.key.length !== 32) {
      throw new Error('MASTER_ENCRYPTION_KEY debe ser base64 de 32 bytes');
    }
  }

  /** Cifra un string UTF-8 y devuelve el envelope `<iv>.<authTag>.<ct>`. */
  encryptString(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [
      iv.toString('base64url'),
      authTag.toString('base64url'),
      encrypted.toString('base64url'),
    ].join('.');
  }

  /** Decifra un envelope `<iv>.<authTag>.<ct>` y devuelve el plaintext UTF-8. */
  decryptString(envelope: string): string {
    const parts = envelope.split('.');
    if (parts.length !== 3) {
      throw new Error('Formato de ciphertext invalido');
    }
    const [ivPart, tagPart, ctPart] = parts;
    if (!ivPart || !tagPart || !ctPart) {
      throw new Error('Formato de ciphertext invalido');
    }
    const iv = Buffer.from(ivPart, 'base64url');
    const authTag = Buffer.from(tagPart, 'base64url');
    const ciphertext = Buffer.from(ctPart, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}
