import { Injectable } from '@nestjs/common';
import {
  type AtRiskKind,
  type AdminAtRiskDto,
  type AdminAtRiskOverviewDto,
  type AdminAtRiskRowDto,
  type AdminAtRiskTenantDto,
} from '@storageos/shared';

import { PrismaAdminService } from '../database/prisma-admin.service';

import { AdminTenantsService } from './admin-tenants.service';
import { AdminTodayExtrasService } from './admin-today-extras.service';

const fmtDay = (d: Date) =>
  d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', timeZone: 'Europe/Madrid' });

/**
 * En riesgo con lo que hace falta para decidir a quién llamar primero: el
 * dinero en juego, quién lo lleva, el último contacto y dos listas más (bajas
 * programadas y suscripciones que no se renovarán).
 */
@Injectable()
export class AdminAtRiskOpsService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly tenants: AdminTenantsService,
    private readonly extras: AdminTodayExtrasService,
  ) {}

  async overview(now = new Date()): Promise<AdminAtRiskOverviewDto> {
    const base: AdminAtRiskDto = await this.tenants.getAtRisk();
    // Las dos secciones de aquí respetan el «ignorar» de su sección (o de todas).
    const hidden = (kind: AtRiskKind, id: string) =>
      base.snoozed.some((s) => s.id === id && (s.kind === null || s.kind === kind));
    const [ending, cancelling] = await this.endingSoon(now);
    const scheduledEnd = ending.filter((r) => !hidden('scheduled_end', r.id));
    const cancelAtPeriodEnd = cancelling.filter((r) => !hidden('cancel_at_period_end', r.id));
    await this.markPlaybooks([...scheduledEnd, ...cancelAtPeriodEnd], now);
    // Todas las listas de tenants de la respuesta base (también las que se
    // añadan), sin la de ignorados.
    const sections = Object.entries(base).filter(
      (entry): entry is [string, AdminAtRiskTenantDto[]] =>
        entry[0] !== 'snoozed' && Array.isArray(entry[1]),
    );
    const all = [...sections.flatMap(([, rows]) => rows), ...scheduledEnd, ...cancelAtPeriodEnd];
    const ids = [...new Set(all.map((r) => r.id))];
    const [monthly, owners, contacts] = await Promise.all([
      this.extras.monthlyByTenant(ids),
      this.owners(ids),
      this.lastContacts(ids),
    ]);
    const enrich = (rows: AdminAtRiskTenantDto[]): AdminAtRiskRowDto[] =>
      rows
        .map((r) => {
          const owner = owners.get(r.id);
          const contact = contacts.get(r.id);
          return {
            ...r,
            monthly: monthly.get(r.id) ?? r.monthly ?? 0,
            ownerId: owner?.id ?? null,
            ownerName: owner?.name ?? null,
            ownerSource: owner?.source ?? null,
            lastContactAt: contact?.at.toISOString() ?? null,
            lastContactType: contact?.type ?? null,
          };
        })
        .sort((a, b) => b.monthly - a.monthly || a.name.localeCompare(b.name));

    const out: Record<string, unknown> = { ...base };
    for (const [key, rows] of sections) out[key] = enrich(rows);
    const monthlyAtStake =
      Math.round(ids.reduce((sum, id) => sum + (monthly.get(id) ?? 0), 0) * 100) / 100;
    return {
      ...(out as AdminAtRiskOverviewDto),
      scheduledEnd: enrich(scheduledEnd),
      cancelAtPeriodEnd: enrich(cancelAtPeriodEnd),
      monthlyAtStake,
    };
  }

  /** «Playbook lanzado el X» (14 días) en las filas de las secciones de aquí. */
  private async markPlaybooks(rows: AdminAtRiskTenantDto[], now: Date): Promise<void> {
    if (rows.length === 0) return;
    const recent = await this.admin.superAdminAuditLog.groupBy({
      by: ['targetTenantId'],
      where: {
        action: 'admin.tenant.retention_playbook',
        targetTenantId: { in: [...new Set(rows.map((r) => r.id))] },
        occurredAt: { gte: new Date(now.getTime() - 14 * 86_400_000) },
      },
      _max: { occurredAt: true },
    });
    const by = new Map(recent.map((r) => [r.targetTenantId, r._max.occurredAt]));
    for (const r of rows) {
      const at = by.get(r.id);
      if (at) r.playbookAt = at.toISOString();
    }
  }

  /** Bajas o anonimizaciones programadas, y los que no renovarán al final del periodo. */
  private async endingSoon(now: Date): Promise<[AdminAtRiskTenantDto[], AdminAtRiskTenantDto[]]> {
    const select = {
      id: true,
      name: true,
      slug: true,
      status: true,
      cancelScheduledAt: true,
      anonymizeScheduledAt: true,
      subscription: {
        select: { currentPeriodEnd: true, plan: { select: { name: true } } },
      },
    } as const;
    const [scheduled, cancelling] = await Promise.all([
      this.admin.tenant.findMany({
        where: {
          deletedAt: null,
          billingExempt: false,
          status: { not: 'cancelled' },
          OR: [{ cancelScheduledAt: { not: null } }, { anonymizeScheduledAt: { not: null } }],
        },
        select,
      }),
      this.admin.tenant.findMany({
        where: {
          deletedAt: null,
          billingExempt: false,
          status: { in: ['active', 'trial'] },
          cancelScheduledAt: null,
          anonymizeScheduledAt: null,
          subscription: { cancelAtPeriodEnd: true, currentPeriodEnd: { gte: now } },
        },
        select,
      }),
    ]);
    const scheduledEnd = scheduled.map((t): AdminAtRiskTenantDto => {
      const anonymize = t.anonymizeScheduledAt;
      const at = anonymize ?? t.cancelScheduledAt;
      return {
        id: t.id,
        name: t.name,
        slug: t.slug,
        status: t.status,
        planName: t.subscription?.plan.name ?? null,
        reason: 'scheduled_end',
        since: at?.toISOString() ?? null,
        detail: anonymize
          ? `Se anonimizará el ${fmtDay(anonymize)}`
          : `Se dará de baja el ${at ? fmtDay(at) : '—'}`,
      };
    });
    const cancelAtPeriodEnd = cancelling.map(
      (t): AdminAtRiskTenantDto => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        status: t.status,
        planName: t.subscription?.plan.name ?? null,
        reason: 'cancel_at_period_end',
        since: t.subscription?.currentPeriodEnd.toISOString() ?? null,
        detail: t.subscription
          ? `No renovará: su periodo pagado acaba el ${fmtDay(t.subscription.currentPeriodEnd)}`
          : 'No renovará',
      }),
    );
    return [scheduledEnd, cancelAtPeriodEnd];
  }

  /**
   * Quién lleva a cada tenant: el responsable de su seguimiento abierto más
   * próximo o, si no hay, su comercial.
   */
  private async owners(
    ids: string[],
  ): Promise<Map<string, { id: string; name: string; source: 'followup' | 'sales' }>> {
    const out = new Map<string, { id: string; name: string; source: 'followup' | 'sales' }>();
    if (ids.length === 0) return out;
    const [followups, reps] = await Promise.all([
      this.admin.tenantFollowup.findMany({
        where: { tenantId: { in: ids }, status: 'pending', assignedToId: { not: null } },
        orderBy: { dueDate: 'asc' },
        select: { tenantId: true, assignedToId: true, assignedTo: { select: { fullName: true } } },
      }),
      this.admin.tenant.findMany({
        where: { id: { in: ids }, salesRepId: { not: null } },
        select: { id: true, salesRepId: true, salesRep: { select: { fullName: true } } },
      }),
    ]);
    for (const f of followups) {
      if (!out.has(f.tenantId) && f.assignedToId && f.assignedTo) {
        out.set(f.tenantId, {
          id: f.assignedToId,
          name: f.assignedTo.fullName,
          source: 'followup',
        });
      }
    }
    for (const t of reps) {
      if (!out.has(t.id) && t.salesRepId && t.salesRep) {
        out.set(t.id, { id: t.salesRepId, name: t.salesRep.fullName, source: 'sales' });
      }
    }
    return out;
  }

  /** Última conversación anotada con cada tenant. */
  private async lastContacts(ids: string[]): Promise<Map<string, { at: Date; type: string }>> {
    if (ids.length === 0) return new Map();
    const rows = await this.admin.tenantInteraction.findMany({
      where: { tenantId: { in: ids } },
      orderBy: [{ tenantId: 'asc' }, { occurredAt: 'desc' }],
      distinct: ['tenantId'],
      select: { tenantId: true, occurredAt: true, type: true },
    });
    return new Map(rows.map((r) => [r.tenantId, { at: r.occurredAt, type: r.type }]));
  }
}
