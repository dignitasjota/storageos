import { resolve4, resolveCname } from 'node:dns/promises';

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { customDomainAlternate } from '@storageos/shared';

import { reconcileAllCustomDomainPauses } from '../../common/custom-domain-pause';
import { PrismaAdminService } from '../database/prisma-admin.service';

import type { Env } from '../../config/env.schema';
import type {
  CustomDomainCheckDto,
  CustomDomainHostCheckDto,
  CustomDomainTargetDto,
} from '@storageos/shared';

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

/** ¿Responde el dominio por https (certificado válido)? Cualquier respuesta cuenta. */
async function probeHttps(domain: string): Promise<boolean> {
  // En pruebas no hay red: un nombre con `nohttps` no responde.
  if (process.env.NODE_ENV === 'test') return !domain.includes('nohttps');
  try {
    await fetch(`https://${domain}/`, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(6000),
    });
    return true;
  } catch {
    return false;
  }
}

/** Resultado de comprobar un dominio: DNS (cada nombre) y, si apunta, https. */
export interface DomainInspection {
  ok: boolean;
  hosts: CustomDomainHostCheckDto[];
  expected: string[];
  /** null = no se probó (el DNS no apunta). */
  httpsOk: boolean | null;
}

/** Cada cuánto se vuelve a mirar la IP de la plataforma. */
const TARGET_TTL_MS = 10 * 60 * 1000;

/** IP ficticia de la plataforma en `NODE_ENV=test`. */
const TEST_PLATFORM_IP = '203.0.113.10';

/**
 * Comprueba el DNS de los dominios propios pendientes y avisa al super admin
 * (una vez) cuando ya apuntan a la plataforma, para que los active.
 *
 * Cada dominio se mira con y sin `www.` (si es la raíz): los dos sirven la web
 * y el que no se guardó redirige al guardado.
 *
 * En `NODE_ENV=test` no consulta DNS: un nombre que empieza por `ready` (o
 * `www.ready` sin `nowww`) apunta y el resto no.
 */
@Injectable()
export class CustomDomainCheckService {
  private readonly logger = new Logger(CustomDomainCheckService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private targetCache: { value: CustomDomainTargetDto; exp: number } | null = null;

  private platformHost(): string {
    return new URL(this.config.get('WEB_BASE_URL', { infer: true })).hostname;
  }

  /**
   * A dónde tiene que apuntar un dominio propio: el dominio de la plataforma
   * (`WEB_BASE_URL`) para los CNAME y sus IPv4 para los registros A.
   */
  async target(): Promise<CustomDomainTargetDto> {
    const host = this.platformHost();
    if (process.env.NODE_ENV === 'test') return { host, addresses: [TEST_PLATFORM_IP] };
    const now = Date.now();
    if (this.targetCache && this.targetCache.exp > now && this.targetCache.value.host === host) {
      return this.targetCache.value;
    }
    const answer = await lookup(host);
    const value = { host, addresses: [...answer.addresses].sort() };
    // Sin respuesta del DNS no se guarda: se vuelve a intentar en la siguiente.
    if (value.addresses.length > 0) this.targetCache = { value, exp: now + TARGET_TTL_MS };
    return value;
  }

  private async resolveHost(
    host: string,
    target: CustomDomainTargetDto,
    platform: DnsAnswer,
  ): Promise<{ ok: boolean; found: string[] }> {
    if (process.env.NODE_ENV === 'test') {
      // `nowww` en el nombre: la forma con `www.` no apunta (para probarlas por separado).
      const ok =
        host.startsWith('ready') || (host.startsWith('www.ready') && !host.includes('nowww'));
      return { ok, found: ok ? [TEST_PLATFORM_IP] : [] };
    }
    const d = await lookup(host);
    return {
      ok: pointsToPlatform(d, target.host, platform),
      found: d.cname ? [d.cname, ...d.addresses] : d.addresses,
    };
  }

  /** El dominio guardado y, si la tiene, su forma con o sin `www.`, por separado. */
  private async resolve(
    domain: string,
  ): Promise<{ ok: boolean; hosts: CustomDomainHostCheckDto[]; expected: string[] }> {
    const target = await this.target();
    const platform: DnsAnswer = { addresses: target.addresses, cname: null };
    const alternate = customDomainAlternate(domain);
    const names: { host: string; purpose: 'primary' | 'alternate' }[] = [
      { host: domain, purpose: 'primary' },
      ...(alternate ? [{ host: alternate, purpose: 'alternate' as const }] : []),
    ];
    const hosts = await Promise.all(
      names.map(async (n) => {
        const r = await this.resolveHost(n.host, target, platform);
        return { host: n.host, purpose: n.purpose, pointsToPlatform: r.ok, found: r.found };
      }),
    );
    return {
      ok: hosts[0]?.pointsToPlatform ?? false,
      hosts,
      expected: target.addresses.length ? target.addresses : [target.host],
    };
  }

  /**
   * DNS y https de un dominio, sin guardar nada. El https solo se prueba si el
   * DNS ya apunta a la plataforma (nunca se hacen peticiones a destinos ajenos).
   */
  async inspect(domain: string): Promise<DomainInspection> {
    const r = await this.resolve(domain);
    const httpsOk = r.ok ? await probeHttps(domain) : null;
    return { ...r, httpsOk };
  }

  async check(tenantId: string): Promise<CustomDomainCheckDto> {
    const t = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: {
        name: true,
        customDomain: true,
        customDomainVerifiedAt: true,
        customDomainPausedVerifiedAt: true,
        customDomainReadyAt: true,
      },
    });
    if (!t?.customDomain) {
      throw new NotFoundException({
        code: 'no_custom_domain',
        message: 'No tienes dominio propio',
      });
    }
    const r = await this.inspect(t.customDomain);
    let readyAt = t.customDomainReadyAt;
    const active = !!t.customDomainVerifiedAt || !!t.customDomainPausedVerifiedAt;
    if (active) {
      await this.recordCheck(tenantId, t.name, t.customDomain, r);
    } else if (r.ok && !readyAt) {
      readyAt = await this.markReady(tenantId, t.name, t.customDomain);
    } else if (!r.ok && readyAt) {
      // Dejó de apuntar antes de activarse: «DNS listo desde…» ya no es cierto.
      await this.admin.tenant.updateMany({
        where: { id: tenantId, customDomainVerifiedAt: null, customDomainReadyAt: { not: null } },
        data: { customDomainReadyAt: null },
      });
      readyAt = null;
    }
    return {
      domain: t.customDomain,
      pointsToPlatform: r.ok,
      hosts: r.hosts,
      found: r.hosts[0]?.found ?? [],
      expected: r.expected,
      readyAt: readyAt ? readyAt.toISOString() : null,
      httpsOk: r.httpsOk,
    };
  }

  /**
   * Guarda el resultado de comprobar un dominio activo y avisa al super admin
   * una vez por episodio cuando deja de responder (de «bien» o «sin
   * comprobar» a «mal»).
   */
  async recordCheck(
    tenantId: string,
    name: string,
    domain: string,
    r: DomainInspection,
  ): Promise<void> {
    const ok = r.ok && r.httpsOk !== false;
    const issue = ok ? null : !r.ok ? 'dns' : 'https';
    const now = new Date();
    if (ok) {
      await this.admin.tenant.updateMany({
        where: { id: tenantId, customDomain: domain },
        data: {
          customDomainCheckedAt: now,
          customDomainCheckOk: true,
          customDomainCheckIssue: null,
        },
      });
      return;
    }
    // Reserva del episodio: solo el que pasa de bien/sin comprobar a mal avisa.
    const claimed = await this.admin.tenant.updateMany({
      where: {
        id: tenantId,
        customDomain: domain,
        OR: [{ customDomainCheckOk: null }, { customDomainCheckOk: true }],
      },
      data: {
        customDomainCheckedAt: now,
        customDomainCheckOk: false,
        customDomainCheckIssue: issue,
      },
    });
    if (claimed.count === 0) {
      await this.admin.tenant.updateMany({
        where: { id: tenantId, customDomain: domain },
        data: { customDomainCheckedAt: now, customDomainCheckIssue: issue },
      });
      return;
    }
    await this.admin.superAdminNotification.create({
      data: {
        type: 'custom_domain.broken',
        title: `${name}: ${domain} ya no responde`,
        body:
          issue === 'dns'
            ? 'El DNS del dominio ya no apunta a la plataforma: su web, la reserva y los enlaces de sus correos están rotos.'
            : 'El dominio apunta a la plataforma pero no responde por https (revisa el Proxy Host y su certificado).',
        link: '/admin/custom-domains',
      },
    });
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

  /**
   * Cada hora, los dominios pendientes: los que ya apuntan avisan (una vez) y a
   * los que dejaron de apuntar se les limpia «DNS listo desde…».
   */
  @Cron('25 * * * *', { name: 'custom-domains.dns-check' })
  async checkPending(): Promise<void> {
    const pending = await this.admin.tenant.findMany({
      where: {
        customDomain: { not: null },
        customDomainVerifiedAt: null,
        customDomainPausedVerifiedAt: null,
        deletedAt: null,
      },
      select: { id: true, name: true, customDomain: true, customDomainReadyAt: true },
      take: 200,
    });
    for (const t of pending) {
      try {
        const r = await this.resolve(t.customDomain!);
        if (r.ok && !t.customDomainReadyAt) {
          await this.markReady(t.id, t.name, t.customDomain!);
        } else if (!r.ok && t.customDomainReadyAt) {
          await this.admin.tenant.updateMany({
            where: { id: t.id, customDomainVerifiedAt: null, customDomainReadyAt: { not: null } },
            data: { customDomainReadyAt: null },
          });
        }
      } catch (err) {
        this.logger.warn(`custom-domain check ${t.customDomain}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Cada día, los dominios ACTIVOS (y los que están en pausa por plan): si el
   * DNS deja de apuntar o el https no responde, avisa al super admin una vez
   * por episodio. Su estado queda en el panel («Responde», «Ya no apunta»).
   */
  @Cron('40 6 * * *', { name: 'custom-domains.active-check' })
  async checkActive(): Promise<number> {
    const active = await this.admin.tenant.findMany({
      where: {
        customDomain: { not: null },
        deletedAt: null,
        OR: [
          { customDomainVerifiedAt: { not: null } },
          { customDomainPausedVerifiedAt: { not: null } },
        ],
      },
      select: { id: true, name: true, customDomain: true },
      take: 500,
    });
    let checked = 0;
    for (const t of active) {
      try {
        await this.recordCheck(t.id, t.name, t.customDomain!, await this.inspect(t.customDomain!));
        checked += 1;
      } catch (err) {
        this.logger.warn(`custom-domain active ${t.customDomain}: ${(err as Error).message}`);
      }
    }
    return checked;
  }

  /**
   * Cada 10 minutos: pausa los dominios cuyo plan ya no incluye la función y
   * reactiva los que la recuperan (red de seguridad: los cambios de plan,
   * funciones o extras ya lo hacen al momento).
   */
  @Cron('*/10 * * * *', { name: 'custom-domains.plan-sync' })
  async syncWithPlans(): Promise<{ paused: string[]; resumed: string[] }> {
    try {
      return await reconcileAllCustomDomainPauses(this.admin);
    } catch (err) {
      this.logger.warn(`custom-domain plan-sync: ${(err as Error).message}`);
      return { paused: [], resumed: [] };
    }
  }
}
