import { InjectQueue } from '@nestjs/bullmq';
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { effectiveFeaturesFromList, resolvePlanFeatures } from '@storageos/shared';
import { Queue } from 'bullmq';

import { reconcileCustomDomainPause } from '../../common/custom-domain-pause';
import { liveOverrideWhere } from '../../common/tenant-features';
import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JOB_EMAIL_SEND, QUEUE_EMAIL } from '../queues/queue-names';
import { CustomDomainCheckService } from '../users/custom-domain-check.service';

import { SuperAdminAuditService } from './super-admin-audit.service';

import type {
  AdminCustomDomainBlockDto,
  AdminCustomDomainDto,
  TenantFeature,
} from '@storageos/shared';

interface ActionMeta {
  superAdminId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

const VERIFIED_ACTION = 'admin.tenant.custom_domain_verified';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Dominios propios de los tenants en el panel admin: cola (pendientes, activos
 * y en pausa), activación con comprobaciones, desactivación y avisos al tenant.
 *
 * «En pausa»: el dominio se activó pero el plan ya no incluye la función. Los
 * enlaces vuelven a la plataforma (`reconcileCustomDomainPause`) y se
 * reactiva solo si la recupera.
 */
@Injectable()
export class AdminCustomDomainsService {
  private readonly logger = new Logger(AdminCustomDomainsService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly superAdminAudit: SuperAdminAuditService,
    private readonly domains: CustomDomainCheckService,
    private readonly notifications: NotificationsService,
    @InjectQueue(QUEUE_EMAIL) private readonly emailQueue: Queue,
  ) {}

  /** Cola de dominios propios (pendientes de activar, activos y en pausa). */
  async list(): Promise<AdminCustomDomainDto[]> {
    const tenants = await this.admin.tenant.findMany({
      where: { customDomain: { not: null }, deletedAt: null },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        customDomain: true,
        customDomainVerifiedAt: true,
        customDomainPausedVerifiedAt: true,
        customDomainReadyAt: true,
        customDomainCheckedAt: true,
        customDomainCheckOk: true,
        customDomainCheckIssue: true,
        subscription: {
          select: { plan: { select: { slug: true, tenantFeatures: true } } },
        },
      },
      orderBy: [{ customDomainVerifiedAt: 'asc' }, { name: 'asc' }],
    });
    const ids = tenants.map((t) => t.id);
    const [overrides, activations] = await Promise.all([
      this.admin.tenantFeatureOverride.findMany({
        where: { tenantId: { in: ids }, ...liveOverrideWhere() },
        select: { tenantId: true, feature: true, enabled: true },
      }),
      // Quién lo activó: la última activación registrada de cada tenant.
      this.admin.auditLog.findMany({
        where: { tenantId: { in: ids }, action: VERIFIED_ACTION },
        orderBy: { occurredAt: 'desc' },
        select: { tenantId: true, changes: true },
      }),
    ]);
    const overridesBy = new Map<string, { feature: TenantFeature; enabled: boolean }[]>();
    for (const o of overrides) {
      const list = overridesBy.get(o.tenantId) ?? [];
      list.push({ feature: o.feature as TenantFeature, enabled: o.enabled });
      overridesBy.set(o.tenantId, list);
    }
    const activatorOf = new Map<string, string>();
    for (const a of activations) {
      if (activatorOf.has(a.tenantId)) continue;
      const by = (a.changes as { superAdminId?: string } | null)?.superAdminId;
      if (by) activatorOf.set(a.tenantId, by);
    }
    const admins = await this.admin.superAdmin.findMany({
      where: { id: { in: [...new Set(activatorOf.values())] } },
      select: { id: true, fullName: true },
    });
    const adminName = new Map(admins.map((a) => [a.id, a.fullName]));

    return tenants.map((t) => {
      const featureEnabled = effectiveFeaturesFromList(
        t.subscription ? resolvePlanFeatures(t.subscription.plan) : [],
        overridesBy.get(t.id) ?? [],
      ).includes('custom_domain');
      const activatedAt = t.customDomainVerifiedAt ?? t.customDomainPausedVerifiedAt;
      const by = activatorOf.get(t.id);
      return {
        tenantId: t.id,
        tenantName: t.name,
        tenantSlug: t.slug,
        customDomain: t.customDomain!,
        verifiedAt: t.customDomainVerifiedAt?.toISOString() ?? null,
        pausedByPlan: !!t.customDomainPausedVerifiedAt && !t.customDomainVerifiedAt,
        activatedAt: activatedAt?.toISOString() ?? null,
        activatedByName: by ? (adminName.get(by) ?? null) : null,
        planSlug: t.subscription?.plan.slug ?? 'free',
        featureEnabled,
        dnsReadyAt: t.customDomainReadyAt?.toISOString() ?? null,
        tenantStatus: t.status,
        checkedAt: t.customDomainCheckedAt?.toISOString() ?? null,
        checkOk: t.customDomainCheckOk,
        checkIssue: t.customDomainCheckIssue,
      };
    });
  }

  private async one(tenantId: string): Promise<AdminCustomDomainDto> {
    return (await this.list()).find((d) => d.tenantId === tenantId)!;
  }

  private async tenantOrThrow(tenantId: string) {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        deletedAt: true,
        customDomain: true,
        customDomainVerifiedAt: true,
        customDomainPausedVerifiedAt: true,
      },
    });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    if (!tenant.customDomain) {
      throw new NotFoundException({ code: 'no_custom_domain', message: 'Sin dominio propio' });
    }
    return { ...tenant, customDomain: tenant.customDomain };
  }

  /**
   * Activa (verifica) el dominio propio de un tenant tras configurar NPM.
   *
   * Se bloquea (409 `custom_domain_not_ready`, con el detalle por nombre) si el
   * plan no incluye la función, si el DNS no apunta a la plataforma o si el
   * https no responde. `force` (solo superadmin) salta las comprobaciones; si
   * el plan no incluye la función, el dominio queda activo pero «En pausa».
   */
  async verify(tenantId: string, args: ActionMeta, force = false): Promise<AdminCustomDomainDto> {
    const tenant = await this.tenantOrThrow(tenantId);
    const featureOk = await this.featureIncluded(tenantId);
    const inspection = await this.domains.inspect(tenant.customDomain);
    if (!force) {
      const blocked =
        !featureOk || !inspection.ok || (inspection.ok && inspection.httpsOk === false);
      if (blocked) {
        const details: AdminCustomDomainBlockDto = {
          featureMissing: !featureOk,
          hosts: inspection.hosts.map((h) => ({
            host: h.host,
            purpose: h.purpose,
            pointsToPlatform: h.pointsToPlatform,
          })),
          httpsOk: inspection.httpsOk,
        };
        throw new ConflictException({
          code: 'custom_domain_not_ready',
          message: this.blockMessage(tenant.customDomain, details),
          details,
        });
      }
    }
    const now = new Date();
    await this.admin.tenant.update({
      where: { id: tenantId },
      data: { customDomainVerifiedAt: now, customDomainPausedVerifiedAt: null },
    });
    await this.domains.recordCheck(tenantId, tenant.name, tenant.customDomain, inspection);
    await this.trace(tenantId, VERIFIED_ACTION, tenant.customDomain, args, { forced: force });
    // Activado a la fuerza sin la función del plan: queda en pausa al momento.
    await reconcileCustomDomainPause(this.admin, tenantId);
    await this.notifyTenant(tenantId, tenant.name, tenant.customDomain, 'activated');
    return this.one(tenantId);
  }

  /** Desactiva (revoca) el dominio propio: deja de servirse bajo la marca. */
  async revoke(tenantId: string, args: ActionMeta): Promise<AdminCustomDomainDto> {
    const tenant = await this.tenantOrThrow(tenantId);
    await this.admin.tenant.update({
      where: { id: tenantId },
      data: {
        customDomainVerifiedAt: null,
        customDomainPausedVerifiedAt: null,
        customDomainCheckedAt: null,
        customDomainCheckOk: null,
        customDomainCheckIssue: null,
      },
    });
    await this.trace(tenantId, 'admin.tenant.custom_domain_revoked', tenant.customDomain, args, {});
    await this.notifyTenant(tenantId, tenant.name, tenant.customDomain, 'deactivated');
    return this.one(tenantId);
  }

  private async featureIncluded(tenantId: string): Promise<boolean> {
    const [subscription, overrides] = await Promise.all([
      this.admin.tenantSubscription.findUnique({
        where: { tenantId },
        include: { plan: { select: { slug: true, tenantFeatures: true } } },
      }),
      this.admin.tenantFeatureOverride.findMany({
        where: { tenantId, ...liveOverrideWhere() },
        select: { feature: true, enabled: true },
      }),
    ]);
    return effectiveFeaturesFromList(
      subscription ? resolvePlanFeatures(subscription.plan) : [],
      overrides as { feature: TenantFeature; enabled: boolean }[],
    ).includes('custom_domain');
  }

  private blockMessage(domain: string, d: AdminCustomDomainBlockDto): string {
    const reasons: string[] = [];
    if (d.featureMissing) reasons.push('su plan no incluye el dominio propio');
    const primary = d.hosts.find((h) => h.purpose === 'primary');
    if (primary && !primary.pointsToPlatform) {
      reasons.push(`el DNS de ${primary.host} no apunta a la plataforma`);
    } else if (d.httpsOk === false) {
      reasons.push(`${domain} no responde por https (revisa el Proxy Host y su certificado)`);
    }
    return `No se puede activar ${domain}: ${reasons.join('; ')}. Puedes activarlo igualmente si sabes lo que haces.`;
  }

  /** Aviso al tenant (panel y correo a los propietarios) al activar o desactivar su dominio. */
  private async notifyTenant(
    tenantId: string,
    tenantName: string,
    domain: string,
    kind: 'activated' | 'deactivated',
  ): Promise<void> {
    const activated = kind === 'activated';
    const title = activated
      ? `Tu dominio ${domain} ya está activo`
      : `Tu dominio ${domain} se ha desactivado`;
    const body = activated
      ? `Tu web, la reserva online y los enlaces de tus correos ya usan ${domain}.`
      : 'Tu web deja de servirse en ese dominio y los enlaces de tus correos vuelven a la dirección de TrasterOS. Si no lo esperabas, escríbenos desde Soporte.';
    try {
      await this.notifications.create(tenantId, {
        type: activated ? 'custom_domain.activated' : 'custom_domain.deactivated',
        title,
        body,
        link: '/settings/domain',
      });
      const owners = await this.admin.user.findMany({
        where: { tenantId, role: 'owner', isActive: true, emailVerifiedAt: { not: null } },
        select: { email: true },
      });
      if (owners.length === 0) return;
      const text = [
        `Hola, equipo de ${tenantName}:`,
        '',
        body,
        '',
        'Un saludo,',
        'El equipo de TrasterOS',
      ].join('\n');
      const html = `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#111;line-height:1.6">${escapeHtml(
        text,
      ).replace(/\n/g, '<br>')}</div>`;
      await this.emailQueue.addBulk(
        owners.map((o) => ({
          name: JOB_EMAIL_SEND,
          data: { to: o.email, kind: 'staff_notice', subject: title, html, text },
        })),
      );
    } catch (err) {
      this.logger.warn(`[custom-domain] aviso al tenant ${tenantId}: ${(err as Error).message}`);
    }
  }

  private async trace(
    tenantId: string,
    action: string,
    domain: string,
    args: ActionMeta,
    extra: Record<string, unknown>,
  ): Promise<void> {
    const changes = { customDomain: domain, ...extra };
    await this.audit.write({
      tenantId,
      userId: null,
      action,
      entityType: 'Tenant',
      entityId: tenantId,
      changes: { superAdminId: args.superAdminId, ...changes },
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
    });
    await this.superAdminAudit.record({
      superAdminId: args.superAdminId,
      action,
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
      changes,
    });
  }
}
