import { randomBytes } from 'node:crypto';

import { hash as argonHash } from '@node-rs/argon2';

import type { Prisma } from '@storageos/database';

/**
 * Enlace nuevo para firmar (o, firmado, completar el pago) de un contrato: se
 * guarda su huella y el anterior deja de valer. Devuelve el token en claro.
 * Con `crypto` se guarda además una copia cifrada, para que un recordatorio
 * reenvíe este mismo enlace en vez de anularlo; sin él, la copia anterior se
 * borra (ya no vale).
 */
export async function issueSigningToken(
  db: Pick<Prisma.TransactionClient, 'contract'>,
  contractId: string,
  expiresAt: Date,
  crypto?: { encryptString(plaintext: string, aad?: string): string },
): Promise<string> {
  const secret = randomBytes(32).toString('hex');
  await db.contract.update({
    where: { id: contractId },
    data: {
      signingTokenHash: await argonHash(secret),
      signingTokenExpiresAt: expiresAt,
      signingTokenEncrypted: crypto ? crypto.encryptString(secret, contractId) : null,
    },
  });
  return `${contractId}.${secret}`;
}

/** Dirección de la firma: en el dominio propio verificado del negocio o en la plataforma. */
export function tenantSignUrl(
  webBaseUrl: string,
  tenant: { customDomain: string | null; customDomainVerifiedAt: Date | null },
  token: string,
): string {
  const base =
    tenant.customDomain && tenant.customDomainVerifiedAt
      ? `https://${tenant.customDomain}`
      : webBaseUrl;
  return `${base}/sign/${token}`;
}
