import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  type AdminCreateSalesAppointmentInput,
  type CreateSalesAppointmentInput,
  platformLeadName,
  SALES_APPOINTMENT_DAY_REMINDER_MINUTES,
  SALES_APPOINTMENT_HOUR_REMINDER_MINUTES,
  SALES_APPOINTMENT_KIND_LABELS,
  type SalesAppointmentDto,
  type SalesAppointmentKind,
  type SalesAppointmentStatus,
  type UpdateSalesAppointmentInput,
} from '@storageos/shared';

import { zonedDayStart, zonedNextDayStart } from '../../../common/format';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { SuperAdminAuditService } from '../super-admin-audit.service';

import { SalesAssignmentService } from './sales-assignment.service';
import { madridToday } from './sales-common';
import { SalesNotifyService } from './sales-notify.service';

const MINUTE = 60_000;
const TZ = 'Europe/Madrid';
/** Una cita se puede poner como mucho con un año de antelación. */
const MAX_AHEAD = 366 * 24 * 60 * MINUTE;
/** Margen para una cita «ahora mismo» (el reloj del navegador puede ir algo atrasado). */
const PAST_GRACE = 5 * MINUTE;

const INCLUDE = {
  lead: { select: { companyName: true, contactName: true, email: true, phone: true } },
  rep: { select: { fullName: true } },
  createdBy: { select: { fullName: true } },
} satisfies Prisma.SalesAppointmentInclude;
type Row = Prisma.SalesAppointmentGetPayload<{ include: typeof INCLUDE }>;

export type AppointmentScope = 'upcoming' | 'past' | 'all';

/** «jueves, 20 de noviembre a las 10:30» en hora de España. */
export function appointmentWhen(d: Date): string {
  const day = new Intl.DateTimeFormat('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: TZ,
  }).format(d);
  return `${day} a las ${appointmentTime(d)}`;
}

export function appointmentTime(d: Date): string {
  return new Intl.DateTimeFormat('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: TZ,
  }).format(d);
}

/**
 * Citas del comercial con sus prospectos y clientes. El comercial las pone en
 * su ficha; la dirección se las pone desde la ficha del lead. Al comercial le
 * llegan los avisos (campana y móvil): al asignársela otra persona, el día
 * antes y una hora antes. La dirección no recibe avisos de citas.
 */
@Injectable()
export class SalesAppointmentsService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly notify: SalesNotifyService,
    private readonly assignment: SalesAssignmentService,
    private readonly audit: SuperAdminAuditService,
  ) {}

  // ----------------------------------------------------------------- lectura

  private toDto(r: Row): SalesAppointmentDto {
    return {
      id: r.id,
      leadId: r.leadId,
      leadName: platformLeadName(r.lead),
      leadPhone: r.lead.phone,
      repId: r.repId,
      repName: r.rep.fullName,
      kind: r.kind as SalesAppointmentKind,
      title: r.title,
      startsAt: r.startsAt.toISOString(),
      durationMinutes: r.durationMinutes,
      location: r.location,
      notes: r.notes,
      status: r.status as SalesAppointmentStatus,
      createdByName: r.createdBy?.fullName ?? null,
      createdByOther: !!r.createdById && r.createdById !== r.repId,
      createdAt: r.createdAt.toISOString(),
    };
  }

  private async list(
    where: Prisma.SalesAppointmentWhereInput,
    scope: AppointmentScope,
    now: Date,
  ): Promise<SalesAppointmentDto[]> {
    const cutoff = new Date(now.getTime() - 60 * MINUTE);
    const scoped: Prisma.SalesAppointmentWhereInput =
      scope === 'upcoming'
        ? { ...where, status: 'scheduled', startsAt: { gte: cutoff } }
        : scope === 'past'
          ? { ...where, OR: [{ startsAt: { lt: cutoff } }, { status: { not: 'scheduled' } }] }
          : where;
    const rows = await this.admin.salesAppointment.findMany({
      where: { ...scoped, lead: { discardedAt: null } },
      orderBy: { startsAt: scope === 'upcoming' ? 'asc' : 'desc' },
      take: 300,
      include: INCLUDE,
    });
    return rows.map((r) => this.toDto(r));
  }

  /** Las del comercial (todas sus cuentas, o las de una). */
  listForRep(
    repId: string,
    q: { leadId?: string; scope?: AppointmentScope },
    now = new Date(),
  ): Promise<SalesAppointmentDto[]> {
    return this.list(
      { repId, ...(q.leadId ? { leadId: q.leadId } : {}) },
      q.scope ?? (q.leadId ? 'all' : 'upcoming'),
      now,
    );
  }

  /** Para la dirección: de todos, de un comercial o de un lead. */
  listAll(
    q: { repId?: string; leadId?: string; scope?: AppointmentScope },
    now = new Date(),
  ): Promise<SalesAppointmentDto[]> {
    return this.list(
      {
        ...(q.repId ? { repId: q.repId } : {}),
        ...(q.leadId ? { leadId: q.leadId } : {}),
      },
      q.scope ?? (q.leadId ? 'all' : 'upcoming'),
      now,
    );
  }

  /** Las pendientes de hoy del comercial (para su «Hoy»). */
  async todayForRep(repId: string, now = new Date()): Promise<SalesAppointmentDto[]> {
    const today = madridToday(now);
    const rows = await this.admin.salesAppointment.findMany({
      where: {
        repId,
        status: 'scheduled',
        startsAt: { gte: zonedDayStart(today), lt: zonedNextDayStart(today) },
        lead: { discardedAt: null },
      },
      orderBy: { startsAt: 'asc' },
      include: INCLUDE,
    });
    return rows.map((r) => this.toDto(r));
  }

  // ------------------------------------------------------------- crear

  private assertWhen(startsAt: Date, now: Date): void {
    if (Number.isNaN(startsAt.getTime())) {
      throw new BadRequestException({ code: 'invalid_date', message: 'Fecha u hora no válidas' });
    }
    if (startsAt.getTime() < now.getTime() - PAST_GRACE) {
      throw new BadRequestException({
        code: 'appointment_in_past',
        message: 'La cita tiene que ser en el futuro',
      });
    }
    if (startsAt.getTime() > now.getTime() + MAX_AHEAD) {
      throw new BadRequestException({
        code: 'appointment_too_far',
        message: 'La cita no puede ser a más de un año vista',
      });
    }
  }

  /**
   * Avisos que ya no tocan porque la cita está demasiado cerca: una cita para
   * dentro de 3 horas no recibe el aviso del día antes.
   */
  private reminderMarks(startsAt: Date, now: Date) {
    const ahead = startsAt.getTime() - now.getTime();
    return {
      dayReminderSentAt: ahead <= SALES_APPOINTMENT_DAY_REMINDER_MINUTES * MINUTE ? now : null,
      hourReminderSentAt: ahead <= SALES_APPOINTMENT_HOUR_REMINDER_MINUTES * MINUTE ? now : null,
    };
  }

  private data(input: CreateSalesAppointmentInput) {
    return {
      kind: input.kind,
      title: input.title,
      durationMinutes: input.durationMinutes,
      location: input.location?.trim() || null,
      notes: input.notes?.trim() || null,
    };
  }

  /** Cita que se pone el propio comercial en la ficha de su cuenta. */
  async createByRep(
    repId: string,
    leadId: string,
    input: CreateSalesAppointmentInput,
    now = new Date(),
  ): Promise<SalesAppointmentDto> {
    await this.assignment.leadOf(repId, leadId);
    const startsAt = new Date(input.startsAt);
    this.assertWhen(startsAt, now);
    const row = await this.admin.salesAppointment.create({
      data: {
        ...this.data(input),
        leadId,
        repId,
        startsAt,
        createdById: repId,
        ...this.reminderMarks(startsAt, now),
      },
      include: INCLUDE,
    });
    return this.toDto(row);
  }

  /**
   * Cita que la dirección le pone a un comercial. Si el lead aún no tiene
   * comercial, pasa a su cartera; si es de otro, no se puede.
   */
  async createByAdmin(
    input: AdminCreateSalesAppointmentInput,
    byId: string,
    now = new Date(),
  ): Promise<SalesAppointmentDto> {
    const lead = await this.admin.platformLead.findFirst({
      where: { id: input.leadId, discardedAt: null },
      select: { id: true, salesRepId: true },
    });
    if (!lead)
      throw new NotFoundException({ code: 'lead_not_found', message: 'Lead no encontrado' });
    const repId = input.repId ?? lead.salesRepId;
    if (!repId) {
      throw new BadRequestException({
        code: 'appointment_rep_required',
        message: 'Elige el comercial que tendrá la cita',
      });
    }
    if (lead.salesRepId && lead.salesRepId !== repId) {
      throw new BadRequestException({
        code: 'appointment_rep_mismatch',
        message: 'Ese lead es de otro comercial: reasígnalo antes en «Equipo comercial»',
      });
    }
    const rep = await this.admin.superAdmin.findFirst({
      where: { id: repId, isActive: true, role: { in: ['sales', 'superadmin'] } },
      select: { id: true },
    });
    if (!rep) {
      throw new BadRequestException({
        code: 'invalid_rep',
        message: 'Ese comercial no existe o está desactivado',
      });
    }
    const startsAt = new Date(input.startsAt);
    this.assertWhen(startsAt, now);
    if (!lead.salesRepId) {
      // A su cartera, sin el aviso de asignación: le llega el de la cita.
      await this.assignment.assign({
        leadId: lead.id,
        repId,
        source: 'manual',
        byId,
        quiet: true,
      });
    }
    const row = await this.admin.salesAppointment.create({
      data: {
        ...this.data(input),
        leadId: lead.id,
        repId,
        startsAt,
        createdById: byId,
        ...this.reminderMarks(startsAt, now),
      },
      include: INCLUDE,
    });
    if (byId !== repId) {
      await this.notify.rep(repId, {
        type: 'sales.appointment',
        title: `Cita con ${platformLeadName(row.lead)}: ${appointmentWhen(startsAt)}`,
        body: this.summary(row),
        link: `/admin/sales/accounts/${row.leadId}`,
      });
    }
    await this.audit.record({
      superAdminId: byId,
      action: 'admin.sales.appointment_created',
      targetType: 'platform_lead',
      targetId: row.leadId,
      changes: { appointmentId: row.id, repId, startsAt: startsAt.toISOString() },
    });
    return this.toDto(row);
  }

  private summary(r: Row): string {
    return [
      `${SALES_APPOINTMENT_KIND_LABELS[r.kind as SalesAppointmentKind]} · ${r.title}`,
      r.location,
    ]
      .filter(Boolean)
      .join(' · ')
      .slice(0, 1000);
  }

  // ------------------------------------------------------------- cambiar

  async updateByRep(
    repId: string,
    id: string,
    input: UpdateSalesAppointmentInput,
    now = new Date(),
  ): Promise<SalesAppointmentDto> {
    const row = await this.admin.salesAppointment.findFirst({
      where: { id, repId, lead: { salesRepId: repId, discardedAt: null } },
    });
    if (!row) throw this.notFound();
    return this.apply(row, input, repId, now);
  }

  async updateByAdmin(
    id: string,
    input: UpdateSalesAppointmentInput,
    byId: string,
    now = new Date(),
  ): Promise<SalesAppointmentDto> {
    const row = await this.admin.salesAppointment.findUnique({ where: { id } });
    if (!row) throw this.notFound();
    return this.apply(row, input, byId, now);
  }

  private async apply(
    row: { id: string; repId: string; startsAt: Date; status: string },
    input: UpdateSalesAppointmentInput,
    byId: string,
    now: Date,
  ): Promise<SalesAppointmentDto> {
    const data: Prisma.SalesAppointmentUncheckedUpdateInput = {};
    if (input.kind) data.kind = input.kind;
    if (input.title) data.title = input.title;
    if (input.durationMinutes) data.durationMinutes = input.durationMinutes;
    if (input.location !== undefined) data.location = input.location?.trim() || null;
    if (input.notes !== undefined) data.notes = input.notes?.trim() || null;
    if (input.status) data.status = input.status;
    let moved = false;
    if (input.startsAt) {
      const startsAt = new Date(input.startsAt);
      if (startsAt.getTime() !== row.startsAt.getTime()) {
        this.assertWhen(startsAt, now);
        data.startsAt = startsAt;
        // Avisos de nuevo para la hora nueva.
        Object.assign(data, this.reminderMarks(startsAt, now));
        moved = true;
      }
    }
    // Reabrir una cita pasada no tiene sentido: hay que darle otra hora.
    if (input.status === 'scheduled' && row.status !== 'scheduled' && !moved) {
      if (row.startsAt.getTime() < now.getTime()) {
        throw new BadRequestException({
          code: 'appointment_in_past',
          message: 'Para reabrirla, ponle una fecha futura',
        });
      }
    }
    const updated = await this.admin.salesAppointment.update({
      where: { id: row.id },
      data,
      include: INCLUDE,
    });
    if (
      byId !== row.repId &&
      updated.status === 'scheduled' &&
      (moved || row.status !== 'scheduled')
    ) {
      await this.notify.rep(row.repId, {
        type: 'sales.appointment',
        title: `Cita cambiada con ${platformLeadName(updated.lead)}: ${appointmentWhen(updated.startsAt)}`,
        body: this.summary(updated),
        link: `/admin/sales/accounts/${updated.leadId}`,
      });
    } else if (byId !== row.repId && updated.status === 'cancelled' && row.status === 'scheduled') {
      await this.notify.rep(row.repId, {
        type: 'sales.appointment',
        title: `Cita cancelada con ${platformLeadName(updated.lead)}`,
        body: `Era el ${appointmentWhen(updated.startsAt)}.`,
        link: `/admin/sales/accounts/${updated.leadId}`,
      });
    }
    return this.toDto(updated);
  }

  async deleteByRep(repId: string, id: string): Promise<void> {
    const { count } = await this.admin.salesAppointment.deleteMany({
      where: { id, repId, lead: { salesRepId: repId } },
    });
    if (!count) throw this.notFound();
  }

  async deleteByAdmin(id: string, byId: string): Promise<void> {
    const row = await this.admin.salesAppointment.findUnique({
      where: { id },
      include: INCLUDE,
    });
    if (!row) throw this.notFound();
    await this.admin.salesAppointment.delete({ where: { id } });
    if (byId !== row.repId && row.status === 'scheduled' && row.startsAt > new Date()) {
      await this.notify.rep(row.repId, {
        type: 'sales.appointment',
        title: `Cita cancelada con ${platformLeadName(row.lead)}`,
        body: `Era el ${appointmentWhen(row.startsAt)}.`,
        link: `/admin/sales/accounts/${row.leadId}`,
      });
    }
  }

  private notFound() {
    return new NotFoundException({ code: 'appointment_not_found', message: 'Cita no encontrada' });
  }

  // ------------------------------------------------------------- avisos

  /**
   * Recordatorios al comercial: el día antes (24 h) y una hora antes. Cada
   * aviso se reserva en la propia cita, así que con varias réplicas sale una
   * sola vez.
   */
  async runReminders(now = new Date()): Promise<{ day: number; hour: number }> {
    const hourLimit = new Date(now.getTime() + SALES_APPOINTMENT_HOUR_REMINDER_MINUTES * MINUTE);
    const dayLimit = new Date(now.getTime() + SALES_APPOINTMENT_DAY_REMINDER_MINUTES * MINUTE);
    const base: Prisma.SalesAppointmentWhereInput = {
      status: 'scheduled',
      startsAt: { gt: now },
      lead: { discardedAt: null },
    };
    let hour = 0;
    let day = 0;

    const soon = await this.admin.salesAppointment.findMany({
      where: { ...base, startsAt: { gt: now, lte: hourLimit }, hourReminderSentAt: null },
      include: INCLUDE,
      take: 500,
    });
    for (const r of soon) {
      const { count } = await this.admin.salesAppointment.updateMany({
        where: { id: r.id, hourReminderSentAt: null },
        data: { hourReminderSentAt: now, dayReminderSentAt: r.dayReminderSentAt ?? now },
      });
      if (!count) continue;
      const minutes = Math.max(1, Math.round((r.startsAt.getTime() - now.getTime()) / MINUTE));
      await this.notify.rep(r.repId, {
        type: 'sales.appointment_reminder',
        title: `A las ${appointmentTime(r.startsAt)} (en ${minutes} min): cita con ${platformLeadName(r.lead)}`,
        body: this.summary(r),
        link: `/admin/sales/accounts/${r.leadId}`,
      });
      hour += 1;
    }

    const tomorrow = await this.admin.salesAppointment.findMany({
      where: { ...base, startsAt: { gt: hourLimit, lte: dayLimit }, dayReminderSentAt: null },
      include: INCLUDE,
      take: 500,
    });
    const todayKey = madridToday(now);
    for (const r of tomorrow) {
      const { count } = await this.admin.salesAppointment.updateMany({
        where: { id: r.id, dayReminderSentAt: null },
        data: { dayReminderSentAt: now },
      });
      if (!count) continue;
      const sameDay = madridToday(r.startsAt) === todayKey;
      await this.notify.rep(r.repId, {
        type: 'sales.appointment_reminder',
        title: `${sameDay ? 'Hoy' : 'Mañana'} a las ${appointmentTime(r.startsAt)}: cita con ${platformLeadName(r.lead)}`,
        body: this.summary(r),
        link: `/admin/sales/accounts/${r.leadId}`,
      });
      day += 1;
    }
    return { day, hour };
  }
}
