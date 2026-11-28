import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { SuperAdminAuditService } from './super-admin-audit.service';

import type { Env } from '../../config/env.schema';
import type { AdminSubdomainCheckDto, AdminTenantSubdomainDto } from '@storageos/shared';

interface ActionMeta {
  superAdminId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

const READY_ACTION = 'admin.tenant.subdomain_ready_changed';
const CHECK_TIMEOUT_MS = 8_000;

/**
 * Subdominios `<slug>.<plataforma>` de cada negocio (SEO web, D4). El
 * certificado de cada subdominio se crea A MANO en el proxy (Nginx Proxy Manager,
 * desafío HTTP): el código no lo hace. Aquí solo se lleva la cuenta de los que
 * faltan por configurar, se marcan como hechos y se comprueba que respondan.
 *
 * Pendiente = `subdomain_ready_at` nulo, en un negocio activo, en prueba o
 * suspendido (un dado de baja no necesita subdominio).
 */
@Injectable()
export class AdminSubdomainsService {
  private readonly logger = new Logger(AdminSubdomainsService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly superAdminAudit: SuperAdminAuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Host de la plataforma con su puerto si lo tiene (`trasteros.pro`, `localhost:3000`). */
  private platformUrl(): URL {
    return new URL(this.config.get('WEB_BASE_URL', { infer: true }));
  }

  /** Subdominio completo de un identificador (`garcia.trasteros.pro`). */
  hostFor(slug: string): string {
    return `${slug}.${this.platformUrl().host}`;
  }

  /** Pendientes con el formato de «Hoy» (dominio = el subdominio completo). */
  async pendingForToday(): Promise<{ tenantId: string; tenantName: string; domain: string }[]> {
    return (await this.list()).map((t) => ({
      tenantId: t.tenantId,
      tenantName: t.tenantName,
      domain: t.host,
    }));
  }

  /** Subdominios pendientes de configurar en el proxy. */
  async list(): Promise<AdminTenantSubdomainDto[]> {
    const rows = await this.admin.tenant.findMany({
      where: {
        deletedAt: null,
        subdomainReadyAt: null,
        status: { in: ['trial', 'active', 'suspended'] },
      },
      orderBy: [{ createdAt: 'asc' }],
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        customDomain: true,
        customDomainVerifiedAt: true,
      },
    });
    return rows.map((t) => ({
      tenantId: t.id,
      tenantName: t.name,
      tenantSlug: t.slug,
      status: t.status,
      host: this.hostFor(t.slug),
      redirectHost: t.customDomain && t.customDomainVerifiedAt ? t.customDomain : null,
      readyAt: null,
    }));
  }

  /** Marca (o desmarca) el subdominio como configurado en el proxy. Auditado. */
  async setReady(tenantId: string, ready: boolean, meta: ActionMeta): Promise<void> {
    const tenant = await this.admin.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: { id: true, slug: true, subdomainReadyAt: true },
    });
    if (!tenant) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    if ((tenant.subdomainReadyAt !== null) === ready) return;
    await this.admin.tenant.update({
      where: { id: tenantId },
      data: { subdomainReadyAt: ready ? new Date() : null },
    });
    const changes = { ready, host: this.hostFor(tenant.slug), superAdminId: meta.superAdminId };
    await this.audit.write({
      tenantId,
      userId: null,
      action: READY_ACTION,
      entityType: 'Tenant',
      entityId: tenantId,
      changes,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    await this.superAdminAudit.record({
      superAdminId: meta.superAdminId,
      action: READY_ACTION,
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      changes,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }

  /**
   * Pide el subdominio y dice si responde. Solo lectura. En tests no sale a la
   * red: un identificador que contiene `nodns` simula un subdominio sin
   * configurar.
   */
  async check(tenantId: string): Promise<AdminSubdomainCheckDto> {
    const tenant = await this.admin.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: { slug: true },
    });
    if (!tenant) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    const host = this.hostFor(tenant.slug);
    if (process.env.NODE_ENV === 'test') {
      return tenant.slug.includes('nodns')
        ? { host, ok: false, status: null, detail: 'No responde: subdominio sin configurar.' }
        : { host, ok: true, status: 200, detail: 'Responde 200: la web está en línea.' };
    }
    const url = this.platformUrl();
    try {
      const res = await fetch(`${url.protocol}//${host}/`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      return { host, ...describeStatus(res.status) };
    } catch (err) {
      this.logger.warn(`Comprobación de ${host} sin respuesta: ${String(err)}`);
      return {
        host,
        ok: false,
        status: null,
        detail:
          'No responde: revisa que el Proxy Host y su certificado estén creados en Nginx Proxy Manager.',
      };
    }
  }
}

/** Lectura de un código HTTP del subdominio para el panel. */
export function describeStatus(status: number): {
  ok: boolean;
  status: number;
  detail: string;
} {
  if (status >= 500) {
    return { ok: false, status, detail: `Responde ${status}: error del servidor.` };
  }
  if (status === 404) {
    return {
      ok: true,
      status,
      detail:
        'Responde 404: la web no se sirve (sin publicar, suspendida o dada de baja). Es lo esperado en esos casos.',
    };
  }
  if (status >= 300) {
    return { ok: true, status, detail: `Responde ${status} (redirección).` };
  }
  return { ok: true, status, detail: `Responde ${status}: la web está en línea.` };
}
