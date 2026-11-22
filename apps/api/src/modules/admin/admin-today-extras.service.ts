import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@storageos/database';
import { platformLeadName } from '@storageos/shared';

import { todayInTimezone, zonedDayStart } from '../../common/format';
import { PrismaAdminService } from '../database/prisma-admin.service';

import type { TodayFingerprint } from './today-fingerprint';
import type {
  AdminAtRiskTenantDto,
  AdminTenantIssueCountDto,
  AdminTodayActivationDto,
  AdminTodayLeadDto,
  PlatformLeadSource,
  AdminTodayDomainDto,
  AdminTodayDoneDto,
  AdminTodayInactiveDto,
  AdminTodayPaymentFailureDto,
  AdminTodayNpsDto,
  AdminTodayWorkloadDto,
  CreateTodaySnoozeInput,
} from '@storageos/shared';

const DAY = 86_400_000;
/** Días de una prueba sin contratos a partir de los que hay que ayudarle. */
const ACTIVATION_DAYS = 7;
/** Hasta qué nota se considera una respuesta NPS baja. */
const NPS_NEGATIVE_MAX = 6;
/** Cobros de la suscripción rechazados que salen en «Hoy» (horas hacia atrás). */
const PAYMENT_FAILURE_HOURS = 48;
/** Días sin que entre nadie del equipo para dar a un cliente por perdido. */
const INACTIVE_DAYS = 14;
/** Un tenant dado de baja o borrado ya no da trabajo a nadie. */
const LIVE_TENANT = { deletedAt: null, status: { not: 'cancelled' as const } };

/** Aviso apartado con la huella de cómo estaba. */
export interface TodaySnoozeRecord {
  id: string;
  kind: string;
  ref: string;
  label: string | null;
  until: string;
  fingerprint: unknown;
}

/** Lo que «Hoy» añade a sus fuentes: avisos, activación, reparto y lo cerrado. */
@Injectable()
export class AdminTodayExtrasService {
  constructor(private readonly admin: PrismaAdminService) {}

  // --------------------------------------------------------------- apartados

  async snoozeRecords(now = new Date()): Promise<TodaySnoozeRecord[]> {
    const rows = await this.admin.adminTodaySnooze.findMany({
      where: { until: { gt: now } },
      orderBy: { until: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      ref: r.ref,
      label: r.label,
      until: r.until.toISOString(),
      fingerprint: r.fingerprint,
    }));
  }

  async snooze(
    input: CreateTodaySnoozeInput,
    superAdminId: string,
    fingerprint: TodayFingerprint | null = null,
  ): Promise<void> {
    const data = {
      label: input.label ?? null,
      until: new Date(Date.now() + input.days * DAY),
      createdById: superAdminId,
      fingerprint: fingerprint ?? Prisma.DbNull,
    };
    await this.admin.adminTodaySnooze.upsert({
      where: { kind_ref: { kind: input.kind, ref: input.ref } },
      create: { kind: input.kind, ref: input.ref, ...data },
      update: data,
    });
  }

  async unsnooze(id: string): Promise<void> {
    const { count } = await this.admin.adminTodaySnooze.deleteMany({ where: { id } });
    if (count === 0) {
      throw new NotFoundException({ code: 'snooze_not_found', message: 'Aviso no encontrado' });
    }
  }

  // ----------------------------------------------------------------- avisos

  /** Leads nuevos (aún nadie les ha respondido), del más antiguo al más nuevo. */
  async newLeads(now = new Date()): Promise<AdminTodayLeadDto[]> {
    const rows = await this.admin.platformLead.findMany({
      where: { status: 'new', discardedAt: null },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: {
        id: true,
        companyName: true,
        contactName: true,
        email: true,
        source: true,
        createdAt: true,
        assignedToId: true,
        assignedTo: { select: { fullName: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      name: platformLeadName(r),
      email: r.email,
      source: r.source as PlatformLeadSource,
      waitingHours: Math.floor((now.getTime() - r.createdAt.getTime()) / 3_600_000),
      assignedToId: r.assignedToId,
      assignedToName: r.assignedTo?.fullName ?? null,
    }));
  }

  async domainsReady(): Promise<AdminTodayDomainDto[]> {
    const rows = await this.admin.tenant.findMany({
      where: {
        deletedAt: null,
        status: { not: 'cancelled' },
        customDomain: { not: null },
        customDomainVerifiedAt: null,
        customDomainReadyAt: { not: null },
      },
      orderBy: { customDomainReadyAt: 'asc' },
      select: { id: true, name: true, customDomain: true },
    });
    return rows.map((r) => ({ tenantId: r.id, tenantName: r.name, domain: r.customDomain ?? '' }));
  }

  /** Facturas de suscripción sin NIF o domicilio: hay que rectificarlas. */
  async incompleteInvoices(now = new Date()): Promise<AdminTenantIssueCountDto[]> {
    const rows = await this.admin.platformInvoice.groupBy({
      by: ['tenantId', 'tenantName'],
      where: {
        status: 'issued',
        issuedAt: { gte: new Date(now.getTime() - 90 * DAY) },
        OR: [{ tenantTaxId: null }, { tenantAddress: null }],
        tenant: { deletedAt: null, status: { not: 'cancelled' } },
      },
      _count: { _all: true },
    });
    return rows
      .map((r) => ({ tenantId: r.tenantId, tenantName: r.tenantName, count: r._count._all }))
      .sort((a, b) => b.count - a.count);
  }

  /** Solicitudes RGPD de inquilinos fuera de plazo: el tenant las tiene sin atender. */
  async rgpdOverdue(now = new Date()): Promise<AdminTenantIssueCountDto[]> {
    const rows = await this.admin.dataSubjectRequest.groupBy({
      by: ['tenantId'],
      where: {
        status: { in: ['open', 'in_progress'] },
        dueAt: { lt: now },
        tenant: { deletedAt: null, status: { not: 'cancelled' } },
      },
      _count: { _all: true },
    });
    if (rows.length === 0) return [];
    const tenants = await this.admin.tenant.findMany({
      where: { id: { in: rows.map((r) => r.tenantId) } },
      select: { id: true, name: true },
    });
    const names = new Map(tenants.map((t) => [t.id, t.name]));
    return rows.map((r) => ({
      tenantId: r.tenantId,
      tenantName: names.get(r.tenantId) ?? '—',
      count: r._count._all,
    }));
  }

  async npsNegative(now = new Date()): Promise<AdminTodayNpsDto[]> {
    const rows = await this.admin.platformNpsResponse.findMany({
      where: {
        score: { lte: NPS_NEGATIVE_MAX },
        respondedAt: { gte: new Date(now.getTime() - 30 * DAY) },
        tenant: { deletedAt: null, status: { not: 'cancelled' } },
      },
      orderBy: { respondedAt: 'desc' },
      take: 20,
      select: {
        id: true,
        tenantId: true,
        score: true,
        comment: true,
        tenant: { select: { name: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenantId,
      tenantName: r.tenant.name,
      score: r.score ?? 0,
      comment: r.comment,
    }));
  }

  // -------------------------------------------------------------- activación

  /** Pruebas de más de una semana sin ningún contrato firmado. */
  async activationStalled(now = new Date()): Promise<AdminTodayActivationDto[]> {
    const rows = await this.admin.tenant.findMany({
      where: {
        deletedAt: null,
        billingExempt: false,
        status: 'trial',
        createdAt: { lte: new Date(now.getTime() - ACTIVATION_DAYS * DAY) },
        contracts: { none: { signedAt: { not: null } } },
      },
      // Los más recientes primero: son los que aún se pueden recuperar.
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        id: true,
        name: true,
        createdAt: true,
        users: {
          where: { role: 'owner', isActive: true },
          take: 1,
          select: { email: true },
        },
        _count: { select: { facilities: { where: { deletedAt: null } }, units: true } },
      },
    });
    return rows.map((r) => ({
      tenantId: r.id,
      tenantName: r.name,
      ownerEmail: r.users[0]?.email ?? null,
      daysSinceSignup: Math.floor((now.getTime() - r.createdAt.getTime()) / DAY),
      missing: r._count.facilities === 0 ? 'facility' : r._count.units === 0 ? 'units' : 'contract',
    }));
  }

  /** Añade a cada prueba cuánto la está usando. */
  async withTrialUsage(trials: AdminAtRiskTenantDto[]): Promise<AdminAtRiskTenantDto[]> {
    if (trials.length === 0) return trials;
    const ids = trials.map((t) => t.id);
    const [counts, logins] = await Promise.all([
      this.admin.tenant.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          _count: {
            select: {
              facilities: { where: { deletedAt: null } },
              units: true,
              contracts: { where: { signedAt: { not: null } } },
            },
          },
        },
      }),
      this.admin.user.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: ids }, isActive: true },
        _max: { lastLoginAt: true },
      }),
    ]);
    const countBy = new Map(counts.map((c) => [c.id, c._count]));
    const loginBy = new Map(logins.map((l) => [l.tenantId, l._max.lastLoginAt]));
    return trials.map((t) => ({
      ...t,
      usage: {
        facilities: countBy.get(t.id)?.facilities ?? 0,
        units: countBy.get(t.id)?.units ?? 0,
        contracts: countBy.get(t.id)?.contracts ?? 0,
        lastLoginAt: loginBy.get(t.id)?.toISOString() ?? null,
      },
    }));
  }

  // ------------------------------------------------------------- el dinero

  /**
   * Lo que paga al mes cada tenant: el plan y los extras sin suspender (precio
   * de lista, como el MRR de la lista de tenants).
   */
  async monthlyByTenant(tenantIds: string[]): Promise<Map<string, number>> {
    const ids = [...new Set(tenantIds)];
    if (ids.length === 0) return new Map();
    const [subs, addons] = await Promise.all([
      this.admin.tenantSubscription.findMany({
        where: { tenantId: { in: ids } },
        select: { tenantId: true, plan: { select: { priceMonthly: true } } },
      }),
      this.admin.tenantSubscriptionAddon.findMany({
        where: { tenantId: { in: ids }, suspendedAt: null },
        select: { tenantId: true, priceMonthly: true, quantity: true },
      }),
    ]);
    const out = new Map<string, number>();
    for (const s of subs) out.set(s.tenantId, Number(s.plan?.priceMonthly ?? 0));
    for (const a of addons) {
      out.set(a.tenantId, (out.get(a.tenantId) ?? 0) + Number(a.priceMonthly) * a.quantity);
    }
    for (const [id, v] of out) out.set(id, Math.round(v * 100) / 100);
    return out;
  }

  /**
   * Cobros de la suscripción rechazados en las últimas 48 h: cargos de Stripe,
   * tarjeta de Redsys de la plataforma y adeudos SEPA devueltos. Uno por tenant
   * (el último) y sin los que ya han pagado después. De más dinero a menos.
   */
  async paymentFailures(now = new Date()): Promise<AdminTodayPaymentFailureDto[]> {
    const since = new Date(now.getTime() - PAYMENT_FAILURE_HOURS * 3_600_000);
    const [payments, orders, bounces] = await Promise.all([
      this.admin.tenantSubscriptionPayment.findMany({
        where: { status: 'failed', recoveredAt: null, updatedAt: { gte: since } },
        select: {
          tenantId: true,
          provider: true,
          amount: true,
          currency: true,
          failedAttempts: true,
          updatedAt: true,
        },
      }),
      this.admin.platformRedsysOrder.findMany({
        where: { status: 'failed', createdAt: { gte: since } },
        select: {
          tenantId: true,
          amountCents: true,
          dsResponse: true,
          kind: true,
          createdAt: true,
        },
      }),
      this.admin.platformSepaRemittanceItem.findMany({
        where: { itemStatus: 'bounced', bouncedAt: { gte: since } },
        select: { tenantId: true, amount: true, bounceReason: true, bouncedAt: true },
      }),
    ]);
    type Failure = Omit<
      AdminTodayPaymentFailureDto,
      'tenantName' | 'failures' | 'pastDue' | 'currency'
    > & {
      currency: string;
      at: Date;
    };
    const all: Failure[] = [
      ...payments.map((p) => ({
        tenantId: p.tenantId,
        source: (p.provider === 'stripe' ? 'stripe' : 'other') as Failure['source'],
        amount: Number(p.amount),
        currency: p.currency,
        reason:
          p.failedAttempts > 1
            ? `Cargo rechazado (${p.failedAttempts} intentos)`
            : 'Cargo rechazado',
        failedAt: p.updatedAt.toISOString(),
        at: p.updatedAt,
      })),
      ...orders.map((o) => ({
        tenantId: o.tenantId,
        source: 'redsys' as const,
        amount: o.amountCents / 100,
        currency: 'EUR',
        reason: `${o.kind === 'auto' ? 'Tarjeta guardada rechazada' : 'Pago con tarjeta rechazado'}${
          o.dsResponse ? ` (código ${o.dsResponse})` : ''
        }`,
        failedAt: o.createdAt.toISOString(),
        at: o.createdAt,
      })),
      ...bounces.map((b) => {
        const at = b.bouncedAt ?? now;
        return {
          tenantId: b.tenantId,
          source: 'sepa' as const,
          amount: b.amount / 100,
          currency: 'EUR',
          reason: b.bounceReason ? `Adeudo devuelto: ${b.bounceReason}` : 'Adeudo devuelto',
          failedAt: at.toISOString(),
          at,
        };
      }),
    ];
    if (all.length === 0) return [];
    const ids = [...new Set(all.map((f) => f.tenantId))];
    const [tenants, paid] = await Promise.all([
      this.admin.tenant.findMany({
        where: { id: { in: ids }, ...LIVE_TENANT, billingExempt: false },
        select: { id: true, name: true, subscription: { select: { status: true } } },
      }),
      this.admin.tenantSubscriptionPayment.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: ids }, status: 'paid', paidAt: { gte: since } },
        _max: { paidAt: true },
      }),
    ]);
    const tenantBy = new Map(tenants.map((t) => [t.id, t]));
    const paidBy = new Map(paid.map((p) => [p.tenantId, p._max.paidAt]));
    const byTenant = new Map<string, { last: Failure; count: number }>();
    for (const f of all) {
      if (!tenantBy.has(f.tenantId)) continue;
      // Ya ha pagado después del rechazo: no hay nada que hacer.
      const paidAt = paidBy.get(f.tenantId);
      if (paidAt && paidAt > f.at) continue;
      const cur = byTenant.get(f.tenantId);
      if (!cur) byTenant.set(f.tenantId, { last: f, count: 1 });
      else {
        cur.count += 1;
        if (f.at > cur.last.at) cur.last = f;
      }
    }
    return [...byTenant.values()]
      .map(({ last, count }) => {
        const t = tenantBy.get(last.tenantId)!;
        return {
          tenantId: last.tenantId,
          tenantName: t.name,
          source: last.source,
          amount: Math.round(last.amount * 100) / 100,
          currency: last.currency,
          reason: last.reason,
          failedAt: last.failedAt,
          failures: count,
          pastDue: t.subscription?.status === 'past_due',
        };
      })
      .sort((a, b) => b.amount - a.amount || b.failedAt.localeCompare(a.failedAt));
  }

  /**
   * Clientes de pago (suscripción activa de un plan con precio, sin exentos ni
   * pruebas) en los que nadie del equipo entra desde hace 14 días: riesgo de
   * baja. Los que más pagan, primero.
   */
  async inactivePaying(now = new Date()): Promise<AdminTodayInactiveDto[]> {
    const cutoff = new Date(now.getTime() - INACTIVE_DAYS * DAY);
    const tenants = await this.admin.tenant.findMany({
      where: {
        deletedAt: null,
        billingExempt: false,
        status: 'active',
        subscription: { status: 'active', plan: { priceMonthly: { gt: 0 } } },
      },
      select: {
        id: true,
        name: true,
        subscription: { select: { plan: { select: { name: true } } } },
      },
    });
    if (tenants.length === 0) return [];
    const logins = await this.admin.user.groupBy({
      by: ['tenantId'],
      where: { tenantId: { in: tenants.map((t) => t.id) }, isActive: true },
      _max: { lastLoginAt: true },
    });
    const loginBy = new Map(logins.map((l) => [l.tenantId, l._max.lastLoginAt ?? null]));
    const idle = tenants.filter((t) => {
      const last = loginBy.get(t.id) ?? null;
      return !last || last < cutoff;
    });
    if (idle.length === 0) return [];
    const monthly = await this.monthlyByTenant(idle.map((t) => t.id));
    return idle
      .map((t) => {
        const last = loginBy.get(t.id) ?? null;
        return {
          tenantId: t.id,
          tenantName: t.name,
          planName: t.subscription?.plan?.name ?? null,
          monthly: monthly.get(t.id) ?? 0,
          lastLoginAt: last?.toISOString() ?? null,
          daysSinceLogin: last ? Math.floor((now.getTime() - last.getTime()) / DAY) : null,
        };
      })
      .sort((a, b) => b.monthly - a.monthly || a.tenantName.localeCompare(b.tenantName));
  }

  // ----------------------------------------------------- reparto y lo cerrado

  async workload(): Promise<AdminTodayWorkloadDto[]> {
    const [tickets, followups] = await Promise.all([
      this.admin.supportTicket.groupBy({
        by: ['assignedAdminId'],
        where: {
          status: { in: ['open', 'in_progress'] },
          assignedAdminId: { not: null },
          tenant: LIVE_TENANT,
        },
        _count: { _all: true },
      }),
      this.admin.tenantFollowup.groupBy({
        by: ['assignedToId'],
        where: { status: 'pending', assignedToId: { not: null }, tenant: LIVE_TENANT },
        _count: { _all: true },
      }),
    ]);
    const ids = [
      ...new Set([
        ...tickets.map((t) => t.assignedAdminId as string),
        ...followups.map((f) => f.assignedToId as string),
      ]),
    ];
    if (ids.length === 0) return [];
    const admins = await this.admin.superAdmin.findMany({
      where: { id: { in: ids } },
      select: { id: true, fullName: true },
    });
    return admins
      .map((a) => ({
        superAdminId: a.id,
        name: a.fullName,
        tickets: tickets.find((t) => t.assignedAdminId === a.id)?._count._all ?? 0,
        followups: followups.find((f) => f.assignedToId === a.id)?._count._all ?? 0,
      }))
      .sort((a, b) => b.tickets + b.followups - (a.tickets + a.followups));
  }

  /** Lo cerrado hoy (día de España). */
  async done(now = new Date()): Promise<AdminTodayDoneDto> {
    const start = zonedDayStart(todayInTimezone('Europe/Madrid', now).toISOString().slice(0, 10));
    const [answered, followupsDone, actions] = await Promise.all([
      // Tickets distintos respondidos hoy (no mensajes: tres respuestas al mismo
      // ticket son un ticket).
      this.admin.supportTicketMessage.findMany({
        where: { authorAdminId: { not: null }, isInternal: false, createdAt: { gte: start } },
        distinct: ['ticketId'],
        select: { ticketId: true },
      }),
      this.admin.tenantFollowup.count({
        where: { status: 'done', completedAt: { gte: start } },
      }),
      this.admin.superAdminAuditLog.findMany({
        where: {
          occurredAt: { gte: start },
          superAdminId: { not: null },
          NOT: [{ action: { startsWith: 'admin.login' } }, { action: { startsWith: 'admin.2fa' } }],
        },
        orderBy: { occurredAt: 'desc' },
        take: 30,
        select: {
          id: true,
          action: true,
          occurredAt: true,
          superAdmin: { select: { fullName: true } },
        },
      }),
    ]);
    return {
      ticketsAnswered: answered.length,
      followupsDone,
      actions: actions.map((a) => ({
        id: a.id,
        at: a.occurredAt.toISOString(),
        action: a.action,
        adminName: a.superAdmin?.fullName ?? null,
      })),
    };
  }
}
