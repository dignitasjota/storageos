import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { searchConsoleSiteAllowed, seoDomainOfProperty } from '@storageos/shared';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type { Env } from '../../config/env.schema';

const bare = (d: string) => d.toLowerCase().replace(/^www\./, '');

/** ¿Es el mismo dominio, o uno cuelga del otro (subdominio)? */
export function seoDomainsRelated(a: string, b: string): boolean {
  const x = bare(a);
  const y = bare(b);
  if (!x.includes('.') || !y.includes('.')) return false;
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}

/**
 * De quién es una web. La cuenta de servicio de Google es la misma para todos
 * los negocios: que tenga acceso a una propiedad NO prueba que sea de quien la
 * pide. Aquí está todo lo que sí lo prueba (o lo desmiente).
 */
@Injectable()
export class SeoDomainOwnershipService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * ¿Es una web del tenant? Su dominio propio verificado, el dominio de su
   * correo (verificado con el TXT de propiedad) o su dirección en la
   * plataforma.
   */
  async ownProperty(tenantId: string, property: string): Promise<boolean> {
    const [tenant, emailDomain] = await Promise.all([
      this.admin.tenant.findUnique({
        where: { id: tenantId },
        select: { slug: true, customDomain: true, customDomainVerifiedAt: true },
      }),
      this.admin.tenantEmailDomain.findFirst({
        where: { tenantId, ownershipVerifiedAt: { not: null } },
        select: { domain: true },
      }),
    ]);
    if (!tenant) return false;
    const platformUrl = this.config.get('WEB_BASE_URL', { infer: true });
    const domains = [
      tenant.customDomainVerifiedAt ? tenant.customDomain : null,
      emailDomain?.domain ?? null,
    ];
    return domains.some((customDomain) =>
      searchConsoleSiteAllowed(property, { slug: tenant.slug, customDomain, platformUrl }),
    );
  }

  /**
   * ¿Es un dominio que prueba ser de OTRO tenant? Su dominio propio verificado,
   * el de su correo verificado o el sitio que tiene conectado en «SEO local».
   * (El dominio que ya usa un proyecto de otro se mira aparte.)
   */
  async belongsToAnotherTenant(owner: string, domain: string): Promise<boolean> {
    const d = bare(domain);
    const [tenants, emailDomains, consoles] = await Promise.all([
      this.admin.tenant.findMany({
        where: {
          id: { not: owner },
          deletedAt: null,
          customDomain: { not: null },
          customDomainVerifiedAt: { not: null },
        },
        select: { customDomain: true },
      }),
      this.admin.tenantEmailDomain.findMany({
        where: { tenantId: { not: owner }, ownershipVerifiedAt: { not: null } },
        select: { domain: true },
      }),
      this.admin.tenantSearchConsole.findMany({
        where: { tenantId: { not: owner } },
        select: { siteUrl: true },
      }),
    ]);
    return (
      tenants.some(
        (t) => t.customDomain && seoDomainsRelated(seoDomainOfProperty(t.customDomain), d),
      ) ||
      emailDomains.some((e) => seoDomainsRelated(e.domain, d)) ||
      consoles.some((c) => seoDomainsRelated(seoDomainOfProperty(c.siteUrl), d))
    );
  }

  /** Dominios de la plataforma: su web, su API, sus ficheros y su correo (y subdominios). */
  isPlatformDomain(domain: string): boolean {
    const hosts: string[] = [];
    for (const key of ['WEB_BASE_URL', 'API_BASE_URL', 'MINIO_PUBLIC_URL'] as const) {
      try {
        hosts.push(new URL(this.config.get(key, { infer: true })).hostname);
      } catch {
        // URL no válida: se ignora.
      }
    }
    const from = this.config.get('EMAIL_FROM_ADDRESS', { infer: true }).split('@')[1];
    if (from) hosts.push(from);
    return hosts.filter((h) => h.includes('.')).some((h) => seoDomainsRelated(domain, h));
  }
}
