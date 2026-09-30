import { resolveTxt } from 'node:dns/promises';

import { Injectable } from '@nestjs/common';

/** Subdominio donde el tenant publica su código de propiedad. */
export const OWNERSHIP_HOST_PREFIX = '_trasteros';
export const OWNERSHIP_VALUE_PREFIX = 'trasteros-verification=';

/**
 * Nombre de un registro relativo al dominio, como lo piden los paneles DNS
 * (que añaden el dominio solos): `_trasteros.x.es` → `_trasteros`; el propio
 * dominio → `@`.
 */
export function relativeDnsHost(host: string, domain: string): string {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  const d = domain.toLowerCase();
  if (!h || h === '@' || h === d) return '@';
  return h.endsWith(`.${d}`) ? h.slice(0, -(d.length + 1)) : h;
}

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
