import { createHash } from 'node:crypto';

/** El enlace del aviso de la lista de espera se guarda como huella. */
export function hashHoldToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
