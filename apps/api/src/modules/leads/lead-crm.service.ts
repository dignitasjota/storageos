import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { emailKey, LeadAutoAssignEnum, phoneKey } from '@storageos/shared';

import { AuditService } from '../auth/audit.service';
import { DOMAIN_EVENTS } from '../automations/domain-events';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

import type { RequestMeta } from '../auth/auth.service';
import type { DomainEventPayload } from '../automations/domain-events';
import type { Prisma } from '@storageos/database';
import type {
  CreateLeadActivityInput,
  CreateLeadFollowupInput,
  LeadActivityDto,
  LeadAutoAssign,
  LeadDuplicateGroupDto,
  LeadDuplicateMemberDto,
  LeadFollowupDto,
  LeadResponseStatsDto,
  LeadResponseUserDto,
  LeadSettingsDto,
  UpdateLeadFollowupInput,
  UpdateLeadSettingsInput,
} from '@storageos/shared';

const followupInclude = {
  lead: { select: { firstName: true, lastName: true, companyName: true } },
  user: { select: { fullName: true } },
} satisfies Prisma.LeadFollowupInclude;
type FollowupRow = Prisma.LeadFollowupGetPayload<{ include: typeof followupInclude }>;

/** Actividades que cuentan como haber atendido al contacto. */
const CONTACT_ACTIVITY_TYPES = new Set(['call', 'visit', 'meeting', 'whatsapp', 'email']);

function leadName(l: {
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  return l.companyName || [l.firstName, l.lastName].filter(Boolean).join(' ').trim() || 'Contacto';
}

function customerLabel(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  const v = s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  return Math.round(v * 10) / 10;
}

function toFollowupDto(r: FollowupRow): LeadFollowupDto {
  return {
    id: r.id,
    leadId: r.leadId,
    leadName: leadName(r.lead),
    title: r.title,
    note: r.note,
    dueDate: r.dueDate.toISOString().slice(0, 10),
    status: r.status as 'pending' | 'done',
    completedAt: r.completedAt?.toISOString() ?? null,
    authorName: r.user?.fullName ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * CRM de contactos: seguimientos y actividad, reparto automático, aviso de los
 * que se quedan sin atender, tiempos de respuesta, duplicados y fusión.
 */
@Injectable()
export class LeadCrmService {
  private readonly logger = new Logger(LeadCrmService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // --------------------------------------------------------------------------
  // Seguimientos
  // --------------------------------------------------------------------------

  async listFollowups(tenantId: string, leadId: string): Promise<LeadFollowupDto[]> {
    await this.assertLead(tenantId, leadId);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.leadFollowup.findMany({
          where: { leadId },
          orderBy: [{ status: 'asc' }, { dueDate: 'asc' }],
          include: followupInclude,
        }),
      tenantId,
    );
    return rows.map(toFollowupDto);
  }

  /** Bandeja: seguimientos pendientes de contactos vivos. */
  async listPendingFollowups(tenantId: string): Promise<LeadFollowupDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.leadFollowup.findMany({
          where: { status: 'pending', lead: { deletedAt: null } },
          orderBy: [{ dueDate: 'asc' }],
          include: followupInclude,
          take: 200,
        }),
      tenantId,
    );
    return rows.map(toFollowupDto);
  }

  async createFollowup(args: {
    tenantId: string;
    userId: string;
    leadId: string;
    input: CreateLeadFollowupInput;
  }): Promise<LeadFollowupDto> {
    await this.assertLead(args.tenantId, args.leadId);
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.leadFollowup.create({
          data: {
            tenantId: args.tenantId,
            leadId: args.leadId,
            userId: args.userId,
            title: args.input.title,
            note: args.input.note ?? null,
            dueDate: new Date(args.input.dueDate),
          },
          include: followupInclude,
        }),
      args.tenantId,
    );
    return toFollowupDto(row);
  }

  async setFollowupStatus(
    tenantId: string,
    id: string,
    input: UpdateLeadFollowupInput,
  ): Promise<LeadFollowupDto> {
    const row = await this.prisma.withTenant(async (tx) => {
      const existing = await tx.leadFollowup.findFirst({ where: { id }, select: { id: true } });
      if (!existing) throw this.followupNotFound();
      return tx.leadFollowup.update({
        where: { id },
        data: {
          status: input.status,
          completedAt: input.status === 'done' ? new Date() : null,
        },
        include: followupInclude,
      });
    }, tenantId);
    return toFollowupDto(row);
  }

  async removeFollowup(tenantId: string, id: string): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      const { count } = await tx.leadFollowup.deleteMany({ where: { id } });
      if (count === 0) throw this.followupNotFound();
    }, tenantId);
  }

  // --------------------------------------------------------------------------
  // Actividad
  // --------------------------------------------------------------------------

  async listActivities(tenantId: string, leadId: string): Promise<LeadActivityDto[]> {
    await this.assertLead(tenantId, leadId);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.leadActivity.findMany({
          where: { leadId },
          orderBy: { occurredAt: 'desc' },
          include: { user: { select: { fullName: true } } },
          take: 200,
        }),
      tenantId,
    );
    return rows.map((r) => ({
      id: r.id,
      leadId: r.leadId,
      type: r.type,
      content: r.content,
      occurredAt: r.occurredAt.toISOString(),
      userName: r.user?.fullName ?? null,
    }));
  }

  /**
   * Registra una llamada, visita o nota. Una llamada, visita, reunión, WhatsApp o
   * email cuenta como primera respuesta: el contacto pasa de «Nuevo» a «Contactado».
   */
  async createActivity(args: {
    tenantId: string;
    userId: string;
    leadId: string;
    input: CreateLeadActivityInput;
  }): Promise<LeadActivityDto> {
    const lead = await this.assertLead(args.tenantId, args.leadId);
    const occurredAt = args.input.occurredAt ? new Date(args.input.occurredAt) : new Date();
    const row = await this.prisma.withTenant(async (tx) => {
      const created = await tx.leadActivity.create({
        data: {
          tenantId: args.tenantId,
          leadId: args.leadId,
          userId: args.userId,
          type: args.input.type,
          content: args.input.content,
          occurredAt,
        },
        include: { user: { select: { fullName: true } } },
      });
      if (CONTACT_ACTIVITY_TYPES.has(args.input.type) && !lead.contactedAt) {
        await tx.lead.update({
          where: { id: args.leadId },
          data: {
            contactedAt: occurredAt,
            ...(lead.status === 'new' ? { status: 'contacted' as const } : {}),
          },
        });
      }
      return created;
    }, args.tenantId);
    return {
      id: row.id,
      leadId: row.leadId,
      type: row.type,
      content: row.content,
      occurredAt: row.occurredAt.toISOString(),
      userName: row.user?.fullName ?? null,
    };
  }

  async removeActivity(tenantId: string, leadId: string, id: string): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      const { count } = await tx.leadActivity.deleteMany({ where: { id, leadId } });
      if (count === 0) {
        throw new NotFoundException({
          code: 'activity_not_found',
          message: 'Actividad no encontrada',
        });
      }
    }, tenantId);
  }

  // --------------------------------------------------------------------------
  // Ajustes, reparto y contactos sin atender
  // --------------------------------------------------------------------------

  async getSettings(tenantId: string): Promise<LeadSettingsDto> {
    const t = await this.admin.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { leadResponseHours: true, leadAutoAssign: true },
    });
    return {
      responseHours: t.leadResponseHours,
      autoAssign: LeadAutoAssignEnum.catch('off').parse(t.leadAutoAssign),
    };
  }

  async updateSettings(args: {
    tenantId: string;
    userId: string;
    input: UpdateLeadSettingsInput;
    meta: RequestMeta;
  }): Promise<LeadSettingsDto> {
    await this.admin.tenant.update({
      where: { id: args.tenantId },
      data: {
        ...(args.input.responseHours !== undefined
          ? { leadResponseHours: args.input.responseHours }
          : {}),
        ...(args.input.autoAssign !== undefined ? { leadAutoAssign: args.input.autoAssign } : {}),
      },
    });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'leads.settings_changed',
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes: args.input,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.getSettings(args.tenantId);
  }

  /** Reparto automático al llegar un contacto sin asignar. */
  @OnEvent(DOMAIN_EVENTS.lead_created, { async: true })
  async onLeadCreated(p: DomainEventPayload): Promise<void> {
    if (!p.leadId) return;
    try {
      await this.autoAssign(p.tenantId, p.leadId);
    } catch (err) {
      this.logger.warn(`Reparto del contacto ${p.leadId} falló: ${(err as Error).message}`);
    }
  }

  /** Devuelve el usuario asignado (o null si no hay reparto o nadie a quien darlo). */
  async autoAssign(tenantId: string, leadId: string): Promise<string | null> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { leadAutoAssign: true },
    });
    const mode = LeadAutoAssignEnum.catch('off').parse(tenant?.leadAutoAssign) as LeadAutoAssign;
    if (mode === 'off') return null;
    const lead = await this.admin.lead.findFirst({
      where: { id: leadId, tenantId, deletedAt: null },
      select: {
        assignedToUserId: true,
        preferredFacilityId: true,
        firstName: true,
        lastName: true,
        companyName: true,
      },
    });
    if (!lead || lead.assignedToUserId) return null;

    const users = await this.admin.user.findMany({
      where: {
        tenantId,
        isActive: true,
        role: { in: ['owner', 'manager', 'staff'] },
      },
      select: { id: true, facilities: { select: { facilityId: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const candidates = users
      .filter(
        (u) =>
          mode !== 'facility' ||
          !lead.preferredFacilityId ||
          u.facilities.length === 0 ||
          u.facilities.some((f) => f.facilityId === lead.preferredFacilityId),
      )
      .map((u) => u.id);
    if (candidates.length === 0) return null;

    // Por turnos: el que hace más tiempo que no recibe un contacto.
    const last = await this.admin.lead.groupBy({
      by: ['assignedToUserId'],
      where: { tenantId, assignedToUserId: { in: candidates } },
      _max: { createdAt: true },
    });
    const lastAt = new Map(last.map((r) => [r.assignedToUserId, r._max.createdAt?.getTime() ?? 0]));
    const chosen = [...candidates].sort((a, b) => (lastAt.get(a) ?? 0) - (lastAt.get(b) ?? 0))[0]!;

    const { count } = await this.admin.lead.updateMany({
      where: { id: leadId, tenantId, assignedToUserId: null },
      data: { assignedToUserId: chosen },
    });
    if (count === 0) return null;
    await this.notifications
      .create(tenantId, {
        type: 'lead.assigned',
        title: `Te han asignado un contacto: ${leadName(lead)}`,
        link: '/leads',
        facilityId: lead.preferredFacilityId,
      })
      .catch(() => undefined);
    return chosen;
  }

  /**
   * Avisa al equipo de los contactos nuevos que llevan más del plazo sin
   * atender. Un aviso por contacto (reserva atómica: vale con varias réplicas).
   */
  async notifyUnattended(now: Date = new Date()): Promise<number> {
    const tenants = await this.admin.tenant.findMany({
      where: { deletedAt: null, status: { in: ['active', 'trial'] } },
      select: { id: true, leadResponseHours: true },
    });
    let notified = 0;
    for (const t of tenants) {
      const limit = new Date(now.getTime() - t.leadResponseHours * 3_600_000);
      const leads = await this.admin.lead.findMany({
        where: {
          tenantId: t.id,
          status: 'new',
          contactedAt: null,
          deletedAt: null,
          unattendedNotifiedAt: null,
          createdAt: { lte: limit, gte: new Date(now.getTime() - 30 * 86_400_000) },
        },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          companyName: true,
          preferredFacilityId: true,
          assignedTo: { select: { fullName: true } },
        },
        take: 100,
      });
      for (const l of leads) {
        const { count } = await this.admin.lead.updateMany({
          where: { id: l.id, unattendedNotifiedAt: null },
          data: { unattendedNotifiedAt: now },
        });
        if (count === 0) continue;
        notified += 1;
        await this.notifications
          .create(t.id, {
            type: 'lead.unattended',
            title: `${leadName(l)} lleva más de ${t.leadResponseHours} h sin atender`,
            ...(l.assignedTo ? { body: `Asignado a ${l.assignedTo.fullName}` } : {}),
            link: '/leads',
            facilityId: l.preferredFacilityId,
          })
          .catch(() => undefined);
      }
    }
    return notified;
  }

  /** Tiempo hasta la primera respuesta, en total y por persona. */
  async responseStats(tenantId: string, days: number): Promise<LeadResponseStatsDto> {
    const span = Math.min(Math.max(Math.trunc(days) || 30, 1), 365);
    const { responseHours } = await this.getSettings(tenantId);
    const since = new Date(Date.now() - span * 86_400_000);
    const [leads, unattended] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.lead.findMany({
            where: { createdAt: { gte: since }, deletedAt: null },
            select: {
              createdAt: true,
              contactedAt: true,
              assignedToUserId: true,
              assignedTo: { select: { fullName: true } },
            },
          }),
          tx.lead.count({
            where: {
              status: 'new',
              contactedAt: null,
              deletedAt: null,
              createdAt: { lte: new Date(Date.now() - responseHours * 3_600_000) },
            },
          }),
        ]),
      tenantId,
    );
    const summarize = (
      rows: typeof leads,
      userId: string | null,
      userName: string,
    ): LeadResponseUserDto => {
      const hours = rows
        .filter((r) => r.contactedAt)
        .map((r) => Math.max(0, (r.contactedAt!.getTime() - r.createdAt.getTime()) / 3_600_000));
      return {
        userId,
        userName,
        leads: rows.length,
        contacted: hours.length,
        medianHours: median(hours),
        withinTargetPct: hours.length
          ? Math.round((hours.filter((h) => h <= responseHours).length / hours.length) * 100)
          : null,
      };
    };
    const byUserMap = new Map<string | null, typeof leads>();
    for (const l of leads) {
      const list = byUserMap.get(l.assignedToUserId) ?? [];
      list.push(l);
      byUserMap.set(l.assignedToUserId, list);
    }
    const byUser = [...byUserMap.entries()]
      .map(([userId, rows]) =>
        summarize(
          rows,
          userId,
          userId ? (rows[0]?.assignedTo?.fullName ?? 'Usuario') : 'Sin asignar',
        ),
      )
      .sort((a, b) => b.leads - a.leads);
    return {
      days: span,
      responseHours,
      unattended,
      overall: summarize(leads, null, 'Todo el equipo'),
      byUser,
    };
  }

  // --------------------------------------------------------------------------
  // Duplicados
  // --------------------------------------------------------------------------

  async duplicates(tenantId: string): Promise<LeadDuplicateGroupDto[]> {
    const [leads, customers] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.lead.findMany({
            where: {
              deletedAt: null,
              status: { notIn: ['won', 'lost'] },
              OR: [{ email: { not: null } }, { phone: { not: null } }],
            },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              companyName: true,
              email: true,
              phone: true,
              status: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'asc' },
            take: 5000,
          }),
          tx.customer.findMany({
            where: { deletedAt: null, OR: [{ email: { not: null } }, { phone: { not: null } }] },
            select: {
              id: true,
              customerType: true,
              firstName: true,
              lastName: true,
              companyName: true,
              email: true,
              phone: true,
            },
            take: 20_000,
          }),
        ]),
      tenantId,
    );
    const customerByEmail = new Map<string, { id: string; name: string }>();
    const customerByPhone = new Map<string, { id: string; name: string }>();
    for (const c of customers) {
      const ref = { id: c.id, name: customerLabel(c) };
      const e = emailKey(c.email);
      const ph = phoneKey(c.phone);
      if (e && !customerByEmail.has(e)) customerByEmail.set(e, ref);
      if (ph && !customerByPhone.has(ph)) customerByPhone.set(ph, ref);
    }
    const member = (l: (typeof leads)[number]): LeadDuplicateMemberDto => ({
      id: l.id,
      displayName: leadName(l),
      email: l.email,
      phone: l.phone,
      status: l.status,
      createdAt: l.createdAt.toISOString(),
    });

    const groups: LeadDuplicateGroupDto[] = [];
    const used = new Set<string>();
    const byEmail = new Map<string, typeof leads>();
    const byPhone = new Map<string, typeof leads>();
    for (const l of leads) {
      const e = emailKey(l.email);
      const ph = phoneKey(l.phone);
      if (e) byEmail.set(e, [...(byEmail.get(e) ?? []), l]);
      if (ph) byPhone.set(ph, [...(byPhone.get(ph) ?? []), l]);
    }
    const collect = (
      reason: 'email' | 'phone',
      map: Map<string, typeof leads>,
      customersMap: Map<string, { id: string; name: string }>,
    ) => {
      for (const [key, list] of map) {
        const fresh = list.filter((l) => !used.has(l.id));
        const customer = customersMap.get(key) ?? null;
        if (fresh.length >= 2 || (fresh.length >= 1 && customer)) {
          fresh.forEach((l) => used.add(l.id));
          groups.push({ reason, key, leads: fresh.map(member), customer });
        }
      }
    };
    collect('email', byEmail, customerByEmail);
    collect('phone', byPhone, customerByPhone);
    return groups.slice(0, 200);
  }

  /**
   * Fusiona `sourceId` en `intoLeadId`: completa los datos que falten, une los
   * mensajes y mueve seguimientos, actividad, correos y conversaciones. El
   * contacto origen queda borrado.
   */
  async merge(args: {
    tenantId: string;
    userId: string;
    sourceId: string;
    intoLeadId: string;
    meta: RequestMeta;
  }): Promise<void> {
    if (args.sourceId === args.intoLeadId) {
      throw new BadRequestException({ code: 'same_lead', message: 'Elige otro contacto' });
    }
    await this.prisma.withTenant(async (tx) => {
      const [source, target] = await Promise.all([
        tx.lead.findFirst({ where: { id: args.sourceId, deletedAt: null } }),
        tx.lead.findFirst({ where: { id: args.intoLeadId, deletedAt: null } }),
      ]);
      if (!source || !target) {
        throw new NotFoundException({ code: 'lead_not_found', message: 'Contacto no encontrado' });
      }
      if (source.convertedCustomerId) {
        throw new BadRequestException({
          code: 'lead_converted',
          message: 'Ese contacto ya es cliente: fusiona el otro en él',
        });
      }
      const messages = [target.message, source.message].filter(
        (m, i, all): m is string => !!m && all.indexOf(m) === i,
      );
      await tx.lead.update({
        where: { id: target.id },
        data: {
          firstName: target.firstName ?? source.firstName,
          lastName: target.lastName ?? source.lastName,
          companyName: target.companyName ?? source.companyName,
          email: target.email ?? source.email,
          phone: target.phone ?? source.phone,
          message: messages.length ? messages.join('\n\n— ') : null,
          preferredFacilityId: target.preferredFacilityId ?? source.preferredFacilityId,
          preferredUnitTypeId: target.preferredUnitTypeId ?? source.preferredUnitTypeId,
          preferredStartDate: target.preferredStartDate ?? source.preferredStartDate,
          budgetMonthly: target.budgetMonthly ?? source.budgetMonthly,
          utmSource: target.utmSource ?? source.utmSource,
          utmMedium: target.utmMedium ?? source.utmMedium,
          utmCampaign: target.utmCampaign ?? source.utmCampaign,
          assignedToUserId: target.assignedToUserId ?? source.assignedToUserId,
          marketingConsentAt: target.marketingConsentAt ?? source.marketingConsentAt,
          contactedAt:
            target.contactedAt && source.contactedAt
              ? new Date(Math.min(target.contactedAt.getTime(), source.contactedAt.getTime()))
              : (target.contactedAt ?? source.contactedAt),
          createdAt: source.createdAt < target.createdAt ? source.createdAt : target.createdAt,
        },
      });
      await tx.leadFollowup.updateMany({
        where: { leadId: source.id },
        data: { leadId: target.id },
      });
      await tx.leadActivity.updateMany({
        where: { leadId: source.id },
        data: { leadId: target.id },
      });
      await tx.communication.updateMany({
        where: { leadId: source.id },
        data: { leadId: target.id },
      });
      await tx.whatsappConversation.updateMany({
        where: { leadId: source.id },
        data: { leadId: target.id },
      });
      await tx.lead.update({
        where: { id: source.id },
        data: {
          deletedAt: new Date(),
          metadata: {
            ...((source.metadata as Record<string, unknown>) ?? {}),
            mergedInto: target.id,
          },
        },
      });
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'lead.merged',
      entityType: 'Lead',
      entityId: args.intoLeadId,
      changes: { mergedLeadId: args.sourceId },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
  }

  /** El contacto es un inquilino que ya existe: lo enlaza y lo da por ganado. */
  async linkCustomer(args: {
    tenantId: string;
    userId: string;
    leadId: string;
    customerId: string;
    meta: RequestMeta;
  }): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      const [lead, customer] = await Promise.all([
        tx.lead.findFirst({ where: { id: args.leadId, deletedAt: null } }),
        tx.customer.findFirst({
          where: { id: args.customerId, deletedAt: null },
          select: { id: true },
        }),
      ]);
      if (!lead) {
        throw new NotFoundException({ code: 'lead_not_found', message: 'Contacto no encontrado' });
      }
      if (!customer) {
        throw new NotFoundException({
          code: 'customer_not_found',
          message: 'Inquilino no encontrado',
        });
      }
      await tx.lead.update({
        where: { id: lead.id },
        data: {
          convertedCustomerId: customer.id,
          status: 'won',
          wonAt: lead.wonAt ?? new Date(),
        },
      });
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'lead.linked_to_customer',
      entityType: 'Lead',
      entityId: args.leadId,
      changes: { customerId: args.customerId },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
  }

  private async assertLead(tenantId: string, leadId: string) {
    const lead = await this.prisma.withTenant(
      (tx) =>
        tx.lead.findFirst({
          where: { id: leadId, deletedAt: null },
          select: { id: true, status: true, contactedAt: true },
        }),
      tenantId,
    );
    if (!lead) {
      throw new NotFoundException({ code: 'lead_not_found', message: 'Contacto no encontrado' });
    }
    return lead;
  }

  private followupNotFound() {
    return new NotFoundException({
      code: 'followup_not_found',
      message: 'Seguimiento no encontrado',
    });
  }
}
