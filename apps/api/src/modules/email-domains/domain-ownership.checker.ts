import { resolveTxt } from 'node:dns/promises';

import { Injectable } from '@nestjs/common';

/** Subdominio donde el tenant publica su código de propiedad. */
export const OWNERSHIP_HOST_PREFIX = '_trasteros';
export const OWNERSHIP_VALUE_PREFIX = 'trasteros-verification=';

export function ownershipHost(domain: string): string {
  return `${OWNERSHIP_HOST_PREFIX}.${domain}`;
}

export function ownershipValue(token: string): string {
  return `${OWNERSHIP_VALUE_PREFIX}${token}`;
}

/**
 * Comprueba que el tenant controla el dominio: el TXT `_trasteros.<dominio>`
 * contiene su código. Hace falta porque todos los dominios viven en la misma
 * cuenta Brevo de la plataforma y Brevo solo prueba que los DNS apuntan a esa
 * cuenta, no a qué tenant pertenece el dominio.
 *
 * En `NODE_ENV=test` no consulta DNS: un dominio que empieza por `noowner` no
 * pasa la comprobación y el resto sí.
 */
@Injectable()
export class DomainOwnershipChecker {
  async check(domain: string, token: string): Promise<boolean> {
    if (process.env.NODE_ENV === 'test') return !domain.startsWith('noowner');
    try {
      const records = await resolveTxt(ownershipHost(domain));
      // Un TXT largo puede venir troceado: se unen los trozos de cada registro.
      return records.some((chunks) => chunks.join('').trim() === ownershipValue(token));
    } catch {
      // NXDOMAIN / sin registros / timeout → aún no publicado.
      return false;
    }
  }
}
