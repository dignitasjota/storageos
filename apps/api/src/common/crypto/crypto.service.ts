import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env.schema';

/**
 * Cifrado simetrico para secrets sensibles guardados en BD (TOTP secret de
 * 2FA, tokens de pasarelas de pago, credenciales AEAT...). AES-256-GCM con
 * `MASTER_ENCRYPTION_KEY` (32 bytes en base64).
 *
 * Formato del ciphertext (todo en base64url, separado por puntos):
 *   `<iv>.<authTag>.<encrypted>`
 *
 * Nunca se loguea ni el plaintext ni el key. El RLS protege la fila a nivel
 * de BD; el cifrado anyade defensa en profundidad ante dumps o backups.
 *
 * **AAD (Additional Authenticated Data)**: los llamadores deben pasar un
 * `aad` que ate el ciphertext a su contexto (normalmente `tenantId`, o
 * `superAdminId` donde no hay tenant). Sin esto, alguien con acceso de
 * escritura crudo a la BD (dump filtrado, `UPDATE` manual, restauración de
 * backup cruzada) podría copiar el ciphertext de la fila de un tenant a la
 * de otro y la app lo descifraría igualmente — el secreto de A se colaría
 * como si fuera de B. Con AAD, GCM ata criptográficamente el ciphertext al
 * contexto en el que se cifró: si se mueve de fila/tenant, el auth tag deja
 * de validar y `decryptString` lanza.
 *
 * Retrocompatibilidad: los envelopes ya guardados en BD se cifraron SIN AAD.
 * `decryptString` intenta primero con el `aad` dado y, si falla, reintenta
 * sin AAD — así los secretos ya existentes (con o sin AAD) se siguen
 * descifrando igual, y el fallback nunca ayuda a un envelope que sí llevaba
 * AAD (el auth tag depende del AAD original, no hay downgrade posible: un
 * ciphertext cifrado con el AAD de A nunca pasa el auth tag check de B, ni
 * con el AAD de B ni sin AAD).
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

  /**
   * Cifra un string UTF-8 y devuelve el envelope `<iv>.<authTag>.<ct>`.
   * `aad` (opcional, recomendado): contexto que ata el ciphertext — pásalo
   * también a `decryptString` para poder descifrarlo.
   */
  encryptString(plaintext: string, aad?: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [
      iv.toString('base64url'),
      authTag.toString('base64url'),
      encrypted.toString('base64url'),
    ].join('.');
  }

  /**
   * Decifra un envelope `<iv>.<authTag>.<ct>` y devuelve el plaintext UTF-8.
   * `aad` debe ser el mismo contexto pasado a `encryptString`. Si el
   * envelope se cifró sin AAD (dato preexistente), reintenta sin `aad` antes
   * de lanzar — ver nota de retrocompatibilidad en la clase.
   */
  decryptString(envelope: string, aad?: string): string {
    if (aad) {
      try {
        return this.decryptWithAad(envelope, aad);
      } catch {
        // Puede ser un envelope preexistente cifrado sin AAD — reintenta
        // sin AAD antes de rendirse. Un envelope cifrado con OTRO AAD (p.
        // ej. el de otro tenant) también fallará aquí, correctamente.
      }
    }
    return this.decryptWithAad(envelope, undefined);
  }

  private decryptWithAad(envelope: string, aad: string | undefined): string {
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
    if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}
