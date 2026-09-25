import { randomBytes } from 'node:crypto';

import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

let dummyHashPromise: Promise<string> | null = null;

/**
 * Ejecuta un `argon2 verify` contra un hash ficticio y devuelve siempre `false`.
 *
 * En un login, la operación cara es verificar la contraseña. Si solo se hace
 * cuando la cuenta existe, un atacante mide el tiempo de respuesta y enumera
 * qué emails (o slugs de empresa) están dados de alta. Llamando a esto en las
 * ramas «no existe» el trabajo es el mismo en todos los caminos.
 */
export async function verifyAgainstDummyHash(password: string): Promise<false> {
  dummyHashPromise ??= argonHash(randomBytes(24).toString('base64url'));
  await argonVerify(await dummyHashPromise, password).catch(() => false);
  return false;
}
