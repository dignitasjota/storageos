import { Injectable, NotFoundException } from '@nestjs/common';
import { platformLeadName } from '@storageos/shared';

import { todayInTimezone, zonedDayStart } from '../../common/format';
import { PrismaAdminService } from '../database/prisma-admin.service';

import type {
  AdminAtRiskTenantDto,
  AdminTenantIssueCountDto,
  AdminTodayActivationDto,
  AdminTodayLeadDto,
  PlatformLeadSource,
  AdminTodayDomainDto,
  AdminTodayDoneDto,
  AdminTodayNpsDto,
  AdminTodaySnoozeDto,
  AdminTodayWorkloadDto,
  CreateTodaySnoozeInput,
} from '@storageos/shared';

const DAY = 86_400_000;
/** Días de una prueba sin contratos a partir de los que hay que ayudarle. */
const ACTIVATION_DAYS = 7;
/** Hasta qué nota se considera una respuesta NPS baja. */
const NPS_NEGATIVE_MAX = 6;

/** Lo que «Hoy» añade a sus fuentes: avisos, activación, reparto y lo cerrado. */
@Injectable()
export class AdminTodayExtrasService {
  constructor(private readonly admin: PrismaAdminService) {}

  // --------------------------------------------------------------- apartados

  async snoozes(now = new Date()): Promise<AdminTodaySnoozeDto[]> {
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
    }));
  }

  async snooze(input: CreateTodaySnoozeInput, superAdminId: string): Promise<void> {
    const data = {
      label: input.label ?? null,
      until: new Date(Date.now() + input.days * DAY),
      createdById: superAdminId,
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
      take: 50,
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

  // ----------------------------------------------------- reparto y lo cerrado

  async workload(): Promise<AdminTodayWorkloadDto[]> {
    const [tickets, followups] = await Promise.all([
      this.admin.supportTicket.groupBy({
        by: ['assignedAdminId'],
        where: { status: { in: ['open', 'in_progress'] }, assignedAdminId: { not: null } },
        _count: { _all: true },
      }),
      this.admin.tenantFollowup.groupBy({
        by: ['assignedToId'],
        where: { status: 'pending', assignedToId: { not: null } },
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
    const [ticketsAnswered, followupsDone, actions] = await Promise.all([
      this.admin.supportTicketMessage.count({
        where: { authorAdminId: { not: null }, isInternal: false, createdAt: { gte: start } },
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
      ticketsAnswered,
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
