import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  buildDomainGuide,
  DOMAIN_CHECKLIST_STEPS,
  DOMAIN_TENANT_NOTICE_COOLDOWN_DAYS,
  domainCertMilestone,
  fillAdminMessageVariables,
  renderAdminEmail,
  type DomainCleanupDto,
  type DomainFullCheckDto,
  type DomainGuideDto,
  type DomainHistoryItemDto,
  type DomainOpsOverviewDto,
  proxyHostNames,
} from '@storageos/shared';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { EmailService } from '../email/email.service';
import { CustomDomainCheckService } from '../users/custom-domain-check.service';

import { AdminSegmentService } from './admin-segment.service';
import { claimAlert } from './alert-state';
import { probeDomain } from './custom-domain-probe';
import { SuperAdminAuditService } from './super-admin-audit.service';

import type { Prisma } from '@storageos/database';

const DAY_MS = 86_400_000;
/** Comprobaciones que se guardan por tenant. */
const KEEP_CHECKS = 60;

interface Meta {
  superAdminId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

type CheckRow = Prisma.PlatformDomainCheckGetPayload<object>;

function checkToDto(row: CheckRow, expected: string[] = []): DomainFullCheckDto {
  const detail = (row.detail ?? {}) as {
    dns?: {
      root?: { host: string; found: string[] };
      www?: { host: string; found: string[] } | null;
    };
    expected?: string[];
  };
  const daysLeft = row.tlsValidTo
    ? Math.ceil((row.tlsValidTo.getTime() - Date.now()) / DAY_MS)
    : null;
  return {
    tenantId: row.tenantId,
    domain: row.domain,
    checkedAt: row.checkedAt.toISOString(),
    trigger: row.trigger as DomainFullCheckDto['trigger'],
    ok: row.ok,
    dns: {
      root: {
        host: detail.dns?.root?.host ?? row.domain,
        ok: row.dnsOk,
        found: detail.dns?.root?.found ?? [],
      },
      www: detail.dns?.www
        ? { host: detail.dns.www.host, ok: row.wwwOk ?? false, found: detail.dns.www.found }
        : null,
      expected: detail.expected ?? expected,
    },
    https: {
      ok: row.httpsOk,
      status: row.httpsStatus,
      ms: row.httpsMs,
      error: row.httpsError,
    },
    tls: {
      valid: row.tlsValid,
      validTo: row.tlsValidTo?.toISOString() ?? null,
      daysLeft,
      error: row.tlsError,
    },
  };
}

/**
 * Dominios propios para el super admin: comprobación completa (DNS, https y
 * certificado), vigilancia de los activos con avisos, guía de activación con
 * casillas, limpieza de Proxy Hosts, historial y ajustes. Convive con
 * `AdminTenantsService.listCustomDomains()` (la lista de siempre).
 */
@Injectable()
export class AdminDomainsOpsService {
  private readonly logger = new Logger(AdminDomainsOpsService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly dns: CustomDomainCheckService,
    private readonly audit: SuperAdminAuditService,
    private readonly segments: AdminSegmentService,
    private readonly email: EmailService,
  ) {}

  // ------------------------------------------------------------- ajustes

  private async settings() {
    return (
      (await this.admin.platformDomainSettings.findFirst()) ??
      (await this.admin.platformDomainSettings.create({ data: {} }))
    );
  }

  async setNotifyTenant(enabled: boolean, meta: Meta): Promise<{ notifyTenantEnabled: boolean }> {
    const s = await this.settings();
    await this.admin.platformDomainSettings.update({
      where: { id: s.id },
      data: { notifyTenantEnabled: enabled },
    });
    await this.audit.record({
      superAdminId: meta.superAdminId,
      action: 'admin.domain.settings_changed',
      changes: { notifyTenantEnabled: enabled },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return { notifyTenantEnabled: enabled };
  }

  // ------------------------------------------------- comprobación completa

  /** Comprueba DNS (raíz y www), respuesta https y certificado, y lo guarda. */
  async fullCheck(
    tenantId: string,
    trigger: DomainFullCheckDto['trigger'],
    byId: string | null = null,
  ): Promise<DomainFullCheckDto> {
    const tenant = await this.admin.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: { customDomain: true },
    });
    if (!tenant?.customDomain) {
      throw new NotFoundException({ code: 'no_custom_domain', message: 'Sin dominio propio' });
    }
    const domain = tenant.customDomain;
    const dns = await this.dns.check(tenantId);
    const root = dns.hosts.find((h) => h.purpose === 'primary');
    const www = dns.hosts.find((h) => h.purpose === 'alternate') ?? null;
    const probe = await probeDomain(domain);
    const dnsOk = root?.pointsToPlatform ?? false;
    const ok = dnsOk && probe.https.ok && probe.tls.valid;
    const row = await this.admin.platformDomainCheck.create({
      data: {
        tenantId,
        domain,
        trigger,
        ok,
        dnsOk,
        wwwOk: www ? www.pointsToPlatform : null,
        httpsOk: probe.https.ok,
        httpsStatus: probe.https.status,
        httpsMs: probe.https.ms,
        httpsError: probe.https.error,
        tlsValid: probe.tls.valid,
        tlsValidTo: probe.tls.validTo,
        tlsError: probe.tls.error,
        detail: {
          dns: {
            root: { host: root?.host ?? domain, found: root?.found ?? [] },
            www: www ? { host: www.host, found: www.found } : null,
          },
          expected: dns.expected,
          ...(byId ? { byId } : {}),
        } as Prisma.InputJsonValue,
      },
    });
    void this.prune(tenantId);
    return checkToDto(row, dns.expected);
  }

  private async prune(tenantId: string): Promise<void> {
    try {
      const old = await this.admin.platformDomainCheck.findMany({
        where: { tenantId },
        orderBy: { checkedAt: 'desc' },
        skip: KEEP_CHECKS,
        select: { id: true },
      });
      if (old.length > 0) {
        await this.admin.platformDomainCheck.deleteMany({
          where: { id: { in: old.map((o) => o.id) } },
        });
      }
    } catch {
      // La limpieza del historial nunca debe romper una comprobación.
    }
  }

  /** «Comprobar todos»: todos los dominios, de cuatro en cuatro. */
  async checkAll(opts: {
    /** Quién lo lanza; null = la tarea programada (que además avisa). */
    byId: string | null;
    onlyActive?: boolean;
  }): Promise<{ checked: number; failing: number }> {
    const { byId, onlyActive = false } = opts;
    const tenants = await this.admin.tenant.findMany({
      where: {
        customDomain: { not: null },
        deletedAt: null,
        ...(onlyActive ? { customDomainVerifiedAt: { not: null } } : {}),
      },
      select: { id: true },
      take: 200,
    });
    let failing = 0;
    let checked = 0;
    for (let i = 0; i < tenants.length; i += 4) {
      const batch = tenants.slice(i, i + 4);
      const results = await Promise.all(
        batch.map((t) =>
          this.fullCheck(t.id, byId ? 'manual' : 'cron', byId)
            .then((r) => ({ id: t.id, r }))
            .catch((err: Error) => {
              this.logger.warn(`full-check ${t.id}: ${err.message}`);
              return null;
            }),
        ),
      );
      for (const x of results) {
        if (!x) continue;
        checked += 1;
        if (!x.r.ok) failing += 1;
        if (!byId) await this.alertAfterCheck(x.id, x.r);
      }
    }
    return { checked, failing };
  }

  // ----------------------------------------------- vigilancia de los activos

  /** Avisos tras comprobar un dominio activo (solo los llama el cron). */
  private async alertAfterCheck(tenantId: string, r: DomainFullCheckDto): Promise<void> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, customDomainVerifiedAt: true },
    });
    if (!tenant?.customDomainVerifiedAt) return;
    const link = '/admin/custom-domains';
    if (!r.ok) {
      const reason = !r.dns.root.ok
        ? 'ya no apunta a la plataforma'
        : !r.https.ok
          ? (r.https.error ?? 'no responde por https')
          : (r.tls.error ?? 'tiene un problema con el certificado');
      if (await claimAlert(this.admin, 'custom_domain.down', `${tenantId}:${r.domain}`, 24 * 60)) {
        await this.admin.superAdminNotification.create({
          data: {
            type: 'custom_domain.down',
            title: `${tenant.name}: ${r.domain} ${reason}`,
            body: 'Los enlaces de ese tenant con su dominio propio pueden estar rotos.',
            link,
          },
        });
      }
      await this.mailTenant(tenantId, tenant.name, 'down', r.domain, reason);
      return;
    }
    const days = r.tls.daysLeft;
    if (days === null) return;
    const milestone = domainCertMilestone(days);
    if (milestone === null) return;
    const stamp = (r.tls.validTo ?? '').slice(0, 10);
    // Un aviso por hito y por certificado (al renovarlo cambia la fecha y empieza de nuevo).
    if (
      await claimAlert(
        this.admin,
        `custom_domain.cert.${milestone}`,
        `${tenantId}:${r.domain}:${stamp}`,
        90 * 24 * 60,
      )
    ) {
      await this.admin.superAdminNotification.create({
        data: {
          type: 'custom_domain.cert_expiring',
          title: `${tenant.name}: el certificado de ${r.domain} caduca en ${Math.max(days, 0)} días`,
          body: 'Renuévalo en Nginx Proxy Manager (Let’s Encrypt) antes de que caduque.',
          link,
        },
      });
    }
    if (days <= 14) {
      await this.mailTenant(
        tenantId,
        tenant.name,
        'cert',
        r.domain,
        `el certificado de seguridad caduca en ${Math.max(days, 0)} días`,
      );
    }
  }

  /** Correo al tenant (si el interruptor está activo) con enfriamiento de 3 días. */
  private async mailTenant(
    tenantId: string,
    tenantName: string,
    kind: 'down' | 'cert',
    domain: string,
    reason: string,
  ): Promise<void> {
    try {
      if (!(await this.settings()).notifyTenantEnabled) return;
      const claimed = await claimAlert(
        this.admin,
        `custom_domain.tenant_notice.${kind}`,
        tenantId,
        DOMAIN_TENANT_NOTICE_COOLDOWN_DAYS * 24 * 60,
      );
      if (!claimed) return;
      const tenant = await this.admin.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, name: true, billingEmail: true },
      });
      if (!tenant) return;
      const subject =
        kind === 'down'
          ? `Tu dominio ${domain} tiene un problema`
          : `El certificado de ${domain} está a punto de caducar`;
      const body =
        kind === 'down'
          ? `Hola {nombre}:\n\nHemos detectado que el dominio ${domain} de ${tenantName} ${reason}. Mientras no se arregle, los enlaces con tu dominio (firma de contratos, área de clientes, reservas) pueden no funcionar.\n\nYa estamos al tanto; si el cambio lo has hecho tú en tu proveedor de dominios, revisa que los registros DNS sigan apuntando a TrasterOS y escríbenos desde Soporte.\n\nEl equipo de TrasterOS`
          : `Hola {nombre}:\n\nEl dominio ${domain} de ${tenantName}: ${reason}. Lo renovaremos nosotros; solo te avisamos por si ves algún aviso de seguridad en el navegador estos días.\n\nEl equipo de TrasterOS`;
      for (const r of await this.segments.recipientsFor([tenant], false)) {
        const vars = { empresa: r.tenantName, nombre: r.fullName };
        const { html, text } = renderAdminEmail(fillAdminMessageVariables(body, vars));
        await this.email
          .sendRendered({
            to: r.email,
            kind: 'admin_message',
            subject,
            html,
            text,
          })
          .catch(() => undefined);
      }
      await this.audit.record({
        superAdminId: null,
        action: 'admin.domain.tenant_notified',
        targetType: 'tenant',
        targetId: tenantId,
        targetTenantId: tenantId,
        changes: { kind, domain },
      });
    } catch (err) {
      this.logger.warn(`aviso al tenant ${tenantId}: ${(err as Error).message}`);
    }
  }

  // -------------------------------------------------------------- resumen

  async overview(): Promise<DomainOpsOverviewDto> {
    const tenants = await this.admin.tenant.findMany({
      where: { customDomain: { not: null }, deletedAt: null },
      select: { id: true, status: true },
    });
    const ids = tenants.map((t) => t.id);
    const [checks, checklists, emails, cleanups, settings] = await Promise.all([
      this.admin.platformDomainCheck.findMany({
        where: { tenantId: { in: ids } },
        distinct: ['tenantId'],
        orderBy: [{ tenantId: 'asc' }, { checkedAt: 'desc' }],
      }),
      this.admin.platformDomainChecklist.findMany({ where: { tenantId: { in: ids } } }),
      this.admin.tenantEmailDomain.findMany({
        where: { tenantId: { in: ids } },
        select: { tenantId: true, domain: true, status: true },
      }),
      this.admin.platformDomainCleanup.groupBy({
        by: ['tenantId'],
        where: { doneAt: null },
        _count: { _all: true },
      }),
      this.settings(),
    ]);
    return {
      notifyTenantEnabled: settings.notifyTenantEnabled,
      rows: tenants.map((t) => {
        const check = checks.find((c) => c.tenantId === t.id);
        const email = emails.find((e) => e.tenantId === t.id);
        return {
          tenantId: t.id,
          tenantStatus: t.status,
          lastCheck: check ? checkToDto(check) : null,
          checklist: (checklists.find((c) => c.tenantId === t.id)?.steps ?? {}) as Record<
            string,
            boolean
          >,
          emailDomain: email
            ? { domain: email.domain, status: email.status, verified: email.status === 'verified' }
            : null,
          pendingCleanups: cleanups.find((c) => c.tenantId === t.id)?._count._all ?? 0,
        };
      }),
    };
  }

  // ----------------------------------------------------------------- guía

  async guide(tenantId: string): Promise<DomainGuideDto> {
    const tenant = await this.admin.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: { customDomain: true },
    });
    if (!tenant?.customDomain) {
      throw new NotFoundException({ code: 'no_custom_domain', message: 'Sin dominio propio' });
    }
    const [target, list] = await Promise.all([
      this.dns.target(),
      this.admin.platformDomainChecklist.findUnique({ where: { tenantId } }),
    ]);
    // Si el dominio cambió, las casillas del anterior no valen.
    const checklist =
      list && list.domain === tenant.customDomain ? (list.steps as Record<string, boolean>) : {};
    return buildDomainGuide(tenant.customDomain, target, checklist);
  }

  async setChecklist(
    tenantId: string,
    steps: Record<string, boolean>,
    meta: Meta,
  ): Promise<DomainGuideDto> {
    const tenant = await this.admin.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: { customDomain: true },
    });
    if (!tenant?.customDomain) {
      throw new NotFoundException({ code: 'no_custom_domain', message: 'Sin dominio propio' });
    }
    const allowed = new Set<string>(DOMAIN_CHECKLIST_STEPS.map((s) => s.key));
    const clean = Object.fromEntries(
      Object.entries(steps)
        .filter(([k]) => allowed.has(k))
        .map(([k, v]) => [k, v === true]),
    );
    await this.admin.platformDomainChecklist.upsert({
      where: { tenantId },
      create: {
        tenantId,
        domain: tenant.customDomain,
        steps: clean,
        updatedById: meta.superAdminId,
      },
      update: { domain: tenant.customDomain, steps: clean, updatedById: meta.superAdminId },
    });
    await this.audit.record({
      superAdminId: meta.superAdminId,
      action: 'admin.domain.checklist_updated',
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      changes: { steps: clean },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return this.guide(tenantId);
  }

  // ------------------------------------------------------------ limpieza

  async cleanups(includeDone = false): Promise<DomainCleanupDto[]> {
    const rows = await this.admin.platformDomainCleanup.findMany({
      where: includeDone ? {} : { doneAt: null },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { tenant: { select: { name: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenantId,
      tenantName: r.tenant.name,
      domain: r.domain,
      reason: r.reason as 'changed' | 'removed',
      proxyHost: proxyHostNames(r.domain).join(', '),
      createdAt: r.createdAt.toISOString(),
      doneAt: r.doneAt?.toISOString() ?? null,
    }));
  }

  async markCleanupDone(id: string, meta: Meta): Promise<DomainCleanupDto> {
    const row = await this.admin.platformDomainCleanup.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException({ code: 'cleanup_not_found', message: 'Tarea no encontrada' });
    }
    if (!row.doneAt) {
      await this.admin.platformDomainCleanup.update({
        where: { id },
        data: { doneAt: new Date(), doneById: meta.superAdminId },
      });
      await this.audit.record({
        superAdminId: meta.superAdminId,
        action: 'admin.domain.cleanup_done',
        targetType: 'tenant',
        targetId: row.tenantId,
        targetTenantId: row.tenantId,
        changes: { domain: row.domain },
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      });
    }
    return (await this.cleanups(true)).find((c) => c.id === id)!;
  }

  // ------------------------------------------------------------ historial

  async history(tenantId: string): Promise<DomainHistoryItemDto[]> {
    const [logs, checks] = await Promise.all([
      this.admin.superAdminAuditLog.findMany({
        where: {
          targetTenantId: tenantId,
          OR: [
            { action: { startsWith: 'admin.tenant.custom_domain' } },
            { action: { startsWith: 'admin.domain.' } },
          ],
        },
        orderBy: { occurredAt: 'desc' },
        take: 100,
        include: { superAdmin: { select: { fullName: true } } },
      }),
      this.admin.platformDomainCheck.findMany({
        where: { tenantId },
        orderBy: { checkedAt: 'desc' },
        take: 60,
      }),
    ]);
    const checkerIds = checks
      .map((c) => (c.detail as { byId?: string } | null)?.byId)
      .filter((x): x is string => !!x);
    const names = new Map(
      (
        await this.admin.superAdmin.findMany({
          where: { id: { in: [...new Set(checkerIds)] } },
          select: { id: true, fullName: true },
        })
      ).map((a) => [a.id, a.fullName]),
    );
    const items: DomainHistoryItemDto[] = [];
    for (const l of logs) {
      const a = l.action;
      const kind: DomainHistoryItemDto['kind'] = a.endsWith('custom_domain_verified')
        ? 'activated'
        : a.endsWith('custom_domain_revoked')
          ? 'revoked'
          : a === 'admin.domain.tenant_notified'
            ? 'notice'
            : 'other';
      const title =
        kind === 'activated'
          ? 'Dominio activado'
          : kind === 'revoked'
            ? 'Dominio desactivado'
            : kind === 'notice'
              ? 'Aviso enviado al tenant'
              : a === 'admin.domain.checklist_updated'
                ? 'Casillas de la guía actualizadas'
                : a === 'admin.domain.cleanup_done'
                  ? 'Proxy Host borrado'
                  : a;
      const changes = l.changes as Record<string, unknown> | null;
      items.push({
        at: l.occurredAt.toISOString(),
        kind,
        title,
        detail:
          changes && Object.keys(changes).length ? JSON.stringify(changes).slice(0, 200) : null,
        by: l.superAdmin?.fullName ?? null,
      });
    }
    for (const c of checks) {
      const byId = (c.detail as { byId?: string } | null)?.byId;
      items.push({
        at: c.checkedAt.toISOString(),
        kind: 'check',
        title: c.ok ? 'Comprobación correcta' : 'Comprobación con problemas',
        detail: c.ok
          ? null
          : [
              !c.dnsOk ? 'DNS no apunta' : null,
              !c.httpsOk ? (c.httpsError ?? 'https no responde') : null,
              !c.tlsValid ? (c.tlsError ?? 'certificado no válido') : null,
            ]
              .filter(Boolean)
              .join(' · '),
        by: byId ? (names.get(byId) ?? null) : null,
      });
    }
    return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 120);
  }
}
