import { resolve4, resolveCname } from 'node:dns/promises';

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type { Env } from '../../config/env.schema';
import type { CustomDomainCheckDto } from '@storageos/shared';

/** Respuesta del DNS de un nombre: sus IPv4 y su CNAME (si tiene). */
export interface DnsAnswer {
  addresses: string[];
  cname: string | null;
}

/**
 * ¿Apunta el dominio a la plataforma? Sí si comparte alguna IPv4 con el
 * dominio de la plataforma o si su CNAME es ese dominio.
 */
export function pointsToPlatform(domain: DnsAnswer, platformHost: string, platform: DnsAnswer) {
  const host = platformHost.toLowerCase().replace(/\.$/, '');
  if (domain.cname && domain.cname.toLowerCase().replace(/\.$/, '') === host) return true;
  return domain.addresses.some((a) => platform.addresses.includes(a));
}

async function lookup(name: string): Promise<DnsAnswer> {
  const [a, c] = await Promise.allSettled([resolve4(name), resolveCname(name)]);
  return {
    addresses: a.status === 'fulfilled' ? a.value : [],
    cname: c.status === 'fulfilled' ? (c.value[0] ?? null) : null,
  };
}

/**
 * Comprueba el DNS de los dominios propios pendientes y avisa al super admin
 * (una vez) cuando ya apuntan a la plataforma, para que los active.
 *
 * En `NODE_ENV=test` no consulta DNS: un dominio que empieza por `ready`
 * apunta y el resto no.
 */
@Injectable()
export class CustomDomainCheckService {
  private readonly logger = new Logger(CustomDomainCheckService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private platformHost(): string {
    return new URL(this.config.get('WEB_BASE_URL', { infer: true })).hostname;
  }

  private async resolve(
    domain: string,
  ): Promise<{ ok: boolean; found: string[]; expected: string[] }> {
    const host = this.platformHost();
    if (process.env.NODE_ENV === 'test') {
      const ok = domain.startsWith('ready');
      return { ok, found: ok ? ['203.0.113.10'] : [], expected: ['203.0.113.10'] };
    }
    const [d, p] = await Promise.all([lookup(domain), lookup(host)]);
    return {
      ok: pointsToPlatform(d, host, p),
      found: d.cname ? [d.cname, ...d.addresses] : d.addresses,
      expected: p.addresses.length ? p.addresses : [host],
    };
  }

  async check(tenantId: string): Promise<CustomDomainCheckDto> {
    const t = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: {
        name: true,
        customDomain: true,
        customDomainVerifiedAt: true,
        customDomainReadyAt: true,
      },
    });
    if (!t?.customDomain) {
      throw new NotFoundException({
        code: 'no_custom_domain',
        message: 'No tienes dominio propio',
      });
    }
    const r = await this.resolve(t.customDomain);
    let readyAt = t.customDomainReadyAt;
    if (r.ok && !t.customDomainVerifiedAt && !readyAt) {
      readyAt = await this.markReady(tenantId, t.name, t.customDomain);
    }
    return {
      domain: t.customDomain,
      pointsToPlatform: r.ok,
      found: r.found,
      expected: r.expected,
      readyAt: readyAt ? readyAt.toISOString() : null,
    };
  }

  /** Marca el dominio como listo y avisa al super admin (una sola vez). */
  private async markReady(tenantId: string, name: string, domain: string): Promise<Date | null> {
    const now = new Date();
    const claimed = await this.admin.tenant.updateMany({
      where: { id: tenantId, customDomain: domain, customDomainReadyAt: null },
      data: { customDomainReadyAt: now },
    });
    if (claimed.count === 0) return null;
    await this.admin.superAdminNotification.create({
      data: {
        type: 'custom_domain.ready',
        title: `${name}: ${domain} ya apunta a la plataforma`,
        body: 'Crea el Proxy Host en Nginx Proxy Manager con su certificado y actívalo.',
        link: '/admin/custom-domains',
      },
    });
    return now;
  }

  /** Cada hora, los dominios pendientes que aún no avisaron. */
  @Cron('25 * * * *', { name: 'custom-domains.dns-check' })
  async checkPending(): Promise<void> {
    const pending = await this.admin.tenant.findMany({
      where: {
        customDomain: { not: null },
        customDomainVerifiedAt: null,
        customDomainReadyAt: null,
        deletedAt: null,
      },
      select: { id: true, name: true, customDomain: true },
      take: 200,
    });
    for (const t of pending) {
      try {
        const r = await this.resolve(t.customDomain!);
        if (r.ok) await this.markReady(t.id, t.name, t.customDomain!);
      } catch (err) {
        this.logger.warn(`custom-domain check ${t.customDomain}: ${(err as Error).message}`);
      }
    }
  }
}
