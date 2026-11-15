import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { emailKey, LeadAutoAssignEnum, leadDisplayName, phoneKey } from '@storageos/shared';

import { addBusinessHours } from '../../common/business-hours';
import { customerScopeWhere } from '../../common/customer-scope';
import { type FacilityScope } from '../../common/facility-scope';
import { assertTeamMember, followupUpdateData } from '../../common/followup-update';
import { anonymizeLeadsTx } from '../../common/lead-anonymize';
import { leadScopeWhere } from '../../common/lead-scope';
import { AuditService } from '../auth/audit.service';
import { DOMAIN_EVENTS } from '../automations/domain-events';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';

import type { RequestMeta } from '../auth/auth.service';
import type { DomainEventPayload } from '../automations/domain-events';
import type { Prisma } from '@storageos/database';
import type {
  OpeningHours,
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
  lead: {
    select: { firstName: true, lastName: true, companyName: true, email: true, phone: true },
  },
  user: { select: { fullName: true } },
  assignedTo: { select: { fullName: true } },
} satisfies Prisma.LeadFollowupInclude;
type FollowupRow = Prisma.LeadFollowupGetPayload<{ include: typeof followupInclude }>;

/** Actividades que cuentan como haber atendido al contacto. */
const CONTACT_ACTIVITY_TYPES = new Set(['call', 'visit', 'meeting', 'whatsapp', 'email']);
/** Margen para el reloj del navegador al anotar algo «ahora». */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

const leadName = (l: Parameters<typeof leadDisplayName>[0]): string => leadDisplayName(l);

function customerLabel(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

/** La más reciente de dos fechas (o la que haya). */
function latest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
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
    status: r.status as LeadFollowupDto['status'],
    completedAt: r.completedAt?.toISOString() ?? null,
    authorName: r.user?.fullName ?? null,
    assignedToUserId: r.assignedToUserId,
    assignedToName: r.assignedTo?.fullName ?? null,
    outcome: r.outcome,
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
    private readonly files: FilesService,
  ) {}

  // --------------------------------------------------------------------------
  // Seguimientos
  // --------------------------------------------------------------------------

  async listFollowups(
    tenantId: string,
    leadId: string,
    scope?: FacilityScope,
  ): Promise<LeadFollowupDto[]> {
    await this.assertLead(tenantId, leadId, scope);
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

  /** Bandeja: seguimientos pendientes de contactos vivos (de los locales que ve). */
  async listPendingFollowups(tenantId: string, scope?: FacilityScope): Promise<LeadFollowupDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.leadFollowup.findMany({
          where: {
            status: 'pending',
            lead: { deletedAt: null, status: { not: 'lost' }, ...leadScopeWhere(scope) },
          },
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
    scope?: FacilityScope;
  }): Promise<LeadFollowupDto> {
    await this.assertLead(args.tenantId, args.leadId, args.scope);
    const row = await this.prisma.withTenant(async (tx) => {
      await assertTeamMember(tx, args.input.assignedToUserId);
      return tx.leadFollowup.create({
        data: {
          tenantId: args.tenantId,
          leadId: args.leadId,
          userId: args.userId,
          assignedToUserId: args.input.assignedToUserId ?? null,
          title: args.input.title,
          note: args.input.note ?? null,
          dueDate: new Date(args.input.dueDate),
        },
        include: followupInclude,
      });
    }, args.tenantId);
    return toFollowupDto(row);
  }

  /**
   * Marcar hecho (con su resultado, que queda en la actividad del contacto),
   * reabrir, posponer, editar o cambiar el responsable.
   */
  async setFollowupStatus(
    tenantId: string,
    id: string,
    input: UpdateLeadFollowupInput,
    scope?: FacilityScope,
    userId?: string,
  ): Promise<LeadFollowupDto> {
    const row = await this.prisma.withTenant(async (tx) => {
      const existing = await tx.leadFollowup.findFirst({
        where: { id, lead: { deletedAt: null, ...leadScopeWhere(scope) } },
        select: { id: true, leadId: true, title: true, status: true },
      });
      if (!existing) throw this.followupNotFound();
      await assertTeamMember(tx, input.assignedToUserId);
      const updated = await tx.leadFollowup.update({
        where: { id },
        data: followupUpdateData(input),
        include: followupInclude,
      });
      if (input.status === 'done' && existing.status !== 'done') {
        await tx.leadActivity.create({
          data: {
            tenantId,
            leadId: existing.leadId,
            userId: userId ?? null,
            type: 'note',
            content: `Seguimiento hecho: ${existing.title}${
              input.outcome?.trim() ? ` — ${input.outcome.trim()}` : ''
            }`,
          },
        });
      }
      return updated;
    }, tenantId);
    return toFollowupDto(row);
  }

  async removeFollowup(tenantId: string, id: string, scope?: FacilityScope): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      const { count } = await tx.leadFollowup.deleteMany({
        where: { id, lead: { deletedAt: null, ...leadScopeWhere(scope) } },
      });
      if (count === 0) throw this.followupNotFound();
    }, tenantId);
  }

  // --------------------------------------------------------------------------
  // Actividad
  // --------------------------------------------------------------------------

  async listActivities(
    tenantId: string,
    leadId: string,
    scope?: FacilityScope,
  ): Promise<LeadActivityDto[]> {
    await this.assertLead(tenantId, leadId, scope);
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
    scope?: FacilityScope;
  }): Promise<LeadActivityDto> {
    const lead = await this.assertLead(args.tenantId, args.leadId, args.scope);
    const occurredAt = args.input.occurredAt ? new Date(args.input.occurredAt) : new Date();
    // Una llamada «del jueves que viene» contaba como respuesta inmediata.
    if (occurredAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
      throw new BadRequestException({
        code: 'occurred_in_future',
        message: 'La fecha no puede ser futura: para lo que está por hacer, crea un seguimiento.',
      });
    }
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
      if (CONTACT_ACTIVITY_TYPES.has(args.input.type)) {
        // Primera respuesta (si no la había), «Nuevo» → «Contactado» y deja de
        // estar marcado como «volvió a escribir».
        await tx.lead.update({
          where: { id: args.leadId },
          data: {
            returnedAt: null,
            // Lo ha tomado una persona: se acaba la secuencia automática.
            nurtureStep: 3,
            ...(lead.contactedAt ? {} : { contactedAt: occurredAt }),
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

  async removeActivity(
    tenantId: string,
    leadId: string,
    id: string,
    scope?: FacilityScope,
  ): Promise<void> {
    await this.assertLead(tenantId, leadId, scope);
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
      select: {
        leadResponseHours: true,
        leadAutoAssign: true,
        leadRetentionMonths: true,
        leadNurtureEnabled: true,
        leadUseBusinessHours: true,
        leadQuoteReminderDays: true,
        messageHours: true,
      },
    });
    return {
      responseHours: t.leadResponseHours,
      autoAssign: LeadAutoAssignEnum.catch('off').parse(t.leadAutoAssign),
      retentionMonths: t.leadRetentionMonths,
      nurtureEnabled: t.leadNurtureEnabled,
      useBusinessHours: t.leadUseBusinessHours,
      businessHoursConfigured: !!t.messageHours,
      quoteReminderDays: t.leadQuoteReminderDays,
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
        ...(args.input.retentionMonths !== undefined
          ? { leadRetentionMonths: args.input.retentionMonths }
          : {}),
        ...(args.input.nurtureEnabled !== undefined
          ? { leadNurtureEnabled: args.input.nurtureEnabled }
          : {}),
        ...(args.input.useBusinessHours !== undefined
          ? { leadUseBusinessHours: args.input.useBusinessHours }
          : {}),
        ...(args.input.quoteReminderDays !== undefined
          ? { leadQuoteReminderDays: args.input.quoteReminderDays }
          : {}),
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
    // Solo a quien lo recibe (antes le llegaba a todo el equipo).
    await this.notifications
      .create(tenantId, {
        type: 'lead.assigned',
        title: `Te han asignado un contacto: ${leadName(lead)}`,
        link: `/leads?lead=${leadId}`,
        facilityId: lead.preferredFacilityId,
        userId: chosen,
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
      select: {
        id: true,
        leadResponseHours: true,
        leadUseBusinessHours: true,
        messageHours: true,
        timezone: true,
      },
    });
    let notified = 0;
    for (const t of tenants) {
      // Con horario de atención, el plazo solo corre en horas de atención.
      const schedule =
        t.leadUseBusinessHours && t.messageHours ? (t.messageHours as OpeningHours) : null;
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
          email: true,
          phone: true,
          preferredFacilityId: true,
          assignedToUserId: true,
          createdAt: true,
          assignedTo: { select: { fullName: true } },
        },
        take: 100,
      });
      for (const l of leads) {
        if (
          schedule &&
          addBusinessHours(l.createdAt, t.leadResponseHours, schedule, t.timezone) > now
        ) {
          continue;
        }
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
            link: `/leads?lead=${l.id}`,
            facilityId: l.preferredFacilityId,
            // A su responsable; sin responsable, a quien ve su local.
            ...(l.assignedToUserId ? { userId: l.assignedToUserId } : {}),
          })
          .catch(() => undefined);
      }
    }
    return notified;
  }

  /** Tiempo hasta la primera respuesta, en total y por persona. */
  async responseStats(
    tenantId: string,
    days: number,
    scope?: FacilityScope,
  ): Promise<LeadResponseStatsDto> {
    const span = Math.min(Math.max(Math.trunc(days) || 30, 1), 365);
    const { responseHours } = await this.getSettings(tenantId);
    const since = new Date(Date.now() - span * 86_400_000);
    const [leads, unattended] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.lead.findMany({
            where: { createdAt: { gte: since }, deletedAt: null, ...leadScopeWhere(scope) },
            select: {
              createdAt: true,
              contactedAt: true,
              metadata: true,
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
              ...leadScopeWhere(scope),
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
    // Quien reservó online solo no esperaba respuesta: no cuenta.
    const attended = leads.filter(
      (l) => l.contactedAt || (l.metadata as { selfBooked?: boolean } | null)?.selfBooked !== true,
    );
    const byUserMap = new Map<string | null, typeof leads>();
    for (const l of attended) {
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
      overall: summarize(attended, null, 'Todo el equipo'),
      byUser,
    };
  }

  // --------------------------------------------------------------------------
  // Duplicados
  // --------------------------------------------------------------------------

  async duplicates(tenantId: string, scope?: FacilityScope): Promise<LeadDuplicateGroupDto[]> {
    const [leads, customers] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.lead.findMany({
            where: {
              deletedAt: null,
              status: { notIn: ['won', 'lost'] },
              AND: [
                { OR: [{ email: { not: null } }, { phone: { not: null } }] },
                leadScopeWhere(scope),
              ],
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
            // Solo inquilinos que puede ver (si no, se le enseñaban sus nombres).
            where: {
              deletedAt: null,
              AND: [
                { OR: [{ email: { not: null } }, { phone: { not: null } }] },
                customerScopeWhere(scope ?? null),
              ],
            },
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
    scope?: FacilityScope;
  }): Promise<void> {
    if (args.sourceId === args.intoLeadId) {
      throw new BadRequestException({ code: 'same_lead', message: 'Elige otro contacto' });
    }
    await this.prisma.withTenant(async (tx) => {
      const visible = { deletedAt: null, ...leadScopeWhere(args.scope) };
      const [source, target] = await Promise.all([
        tx.lead.findFirst({ where: { id: args.sourceId, ...visible } }),
        tx.lead.findFirst({ where: { id: args.intoLeadId, ...visible } }),
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
          // Si cualquiera de los dos se dio de baja de las ofertas, sigue de baja.
          marketingOptOutAt: latest(target.marketingOptOutAt, source.marketingOptOutAt),
          returnedAt: latest(target.returnedAt, source.returnedAt),
          bookedAt: target.bookedAt ?? source.bookedAt,
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
      await tx.webChatConversation.updateMany({
        where: { leadId: source.id },
        data: { leadId: target.id },
      });
      // Presupuestos y visitas también: si no, se quedarían en la ficha borrada.
      await tx.leadQuote.updateMany({
        where: { leadId: source.id },
        data: { leadId: target.id },
      });
      await tx.leadVisit.updateMany({
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
    scope?: FacilityScope;
  }): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      const [lead, customer] = await Promise.all([
        tx.lead.findFirst({
          where: { id: args.leadId, deletedAt: null, ...leadScopeWhere(args.scope) },
        }),
        tx.customer.findFirst({
          where: {
            id: args.customerId,
            deletedAt: null,
            ...customerScopeWhere(args.scope ?? null),
          },
          select: { id: true, marketingOptOutAt: true },
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
      // Ya enlazado con otro inquilino: no se pisa sin avisar.
      if (lead.convertedCustomerId && lead.convertedCustomerId !== customer.id) {
        throw new ConflictException({
          code: 'lead_already_linked',
          message: 'Este contacto ya está enlazado con otro inquilino',
        });
      }
      await tx.lead.update({
        where: { id: lead.id },
        data: {
          convertedCustomerId: customer.id,
          status: 'won',
          wonAt: lead.wonAt ?? new Date(),
          lostAt: null,
          lostReason: null,
          lostReasonCode: null,
          returnedAt: null,
        },
      });
      if (lead.marketingOptOutAt && !customer.marketingOptOutAt) {
        await tx.customer.update({
          where: { id: customer.id },
          data: { marketingOptOutAt: lead.marketingOptOutAt },
        });
      }
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

  /**
   * Borra los datos de los contactos perdidos que llevan más de lo que guarda
   * cada empresa sin actividad (12 meses por defecto).
   */
  async anonymizeStale(now: Date = new Date()): Promise<number> {
    const tenants = await this.admin.tenant.findMany({
      where: { deletedAt: null },
      select: { id: true, leadRetentionMonths: true },
    });
    let total = 0;
    for (const t of tenants) {
      const limit = new Date(now);
      limit.setUTCMonth(limit.getUTCMonth() - t.leadRetentionMonths);
      const stale = await this.admin.lead.findMany({
        where: {
          tenantId: t.id,
          deletedAt: null,
          status: 'lost',
          lostAt: { lt: limit },
          updatedAt: { lt: limit },
          activities: { none: { occurredAt: { gte: limit } } },
          communications: { none: { createdAt: { gte: limit } } },
        },
        select: { id: true },
        take: 500,
      });
      if (stale.length === 0) continue;
      const { count, mediaKeys } = await this.prisma.withTenant(
        (tx) =>
          anonymizeLeadsTx(
            tx,
            stale.map((l) => l.id),
          ),
        t.id,
      );
      if (mediaKeys.length > 0) {
        await this.files.deleteObjects('uploads', mediaKeys).catch(() => undefined);
      }
      total += count;
    }
    return total;
  }

  private async assertLead(tenantId: string, leadId: string, scope?: FacilityScope) {
    const lead = await this.prisma.withTenant(
      (tx) =>
        tx.lead.findFirst({
          where: { id: leadId, deletedAt: null, ...leadScopeWhere(scope) },
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
