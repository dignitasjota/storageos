import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@storageos/database';
import { leadDisplayName } from '@storageos/shared';

import { assertFacilityAllowed, type FacilityScope } from '../../common/facility-scope';
import { assertTeamMember } from '../../common/followup-update';
import { formatDateLong, todayInTimezone } from '../../common/format';
import { leadScopeWhere } from '../../common/lead-scope';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

import type {
  CreateLeadVisitInput,
  LeadVisitDto,
  LeadVisitStatus,
  UpdateLeadVisitInput,
} from '@storageos/shared';

const include = {
  lead: {
    select: { firstName: true, lastName: true, companyName: true, email: true, phone: true },
  },
  facility: { select: { name: true } },
  user: { select: { fullName: true } },
} satisfies Prisma.LeadVisitInclude;
type Row = Prisma.LeadVisitGetPayload<{ include: typeof include }>;

const HOUR = 3_600_000;
/** El recordatorio sale el día antes (entre 20 y 28 h antes). */
const REMIND_FROM_H = 20;
const REMIND_TO_H = 28;

function toDto(r: Row): LeadVisitDto {
  return {
    id: r.id,
    leadId: r.leadId,
    leadName: leadDisplayName(r.lead),
    facilityId: r.facilityId,
    facilityName: r.facility?.name ?? null,
    scheduledAt: r.scheduledAt.toISOString(),
    status: r.status as LeadVisitStatus,
    notes: r.notes,
    userId: r.userId,
    userName: r.user?.fullName ?? null,
  };
}

/**
 * Visitas al local de un contacto: se programan, salen en el calendario, el
 * contacto recibe un recordatorio el día antes y, al marcarla hecha, queda un
 * seguimiento para cerrar la venta.
 */
@Injectable()
export class LeadVisitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly communications: CommunicationsService,
    private readonly notifications: NotificationsService,
  ) {}

  private notFound() {
    return new NotFoundException({ code: 'visit_not_found', message: 'Visita no encontrada' });
  }

  async list(tenantId: string, leadId: string, scope?: FacilityScope): Promise<LeadVisitDto[]> {
    const rows = await this.prisma.withTenant(async (tx) => {
      const lead = await tx.lead.findFirst({
        where: { id: leadId, deletedAt: null, ...leadScopeWhere(scope) },
        select: { id: true },
      });
      if (!lead) {
        throw new NotFoundException({ code: 'lead_not_found', message: 'Contacto no encontrado' });
      }
      return tx.leadVisit.findMany({
        where: { leadId },
        orderBy: { scheduledAt: 'desc' },
        include,
        take: 50,
      });
    }, tenantId);
    return rows.map(toDto);
  }

  async create(args: {
    tenantId: string;
    userId: string;
    leadId: string;
    input: CreateLeadVisitInput;
    scope?: FacilityScope;
  }): Promise<LeadVisitDto> {
    if (args.input.facilityId) assertFacilityAllowed(args.scope, args.input.facilityId);
    const row = await this.prisma.withTenant(async (tx) => {
      const lead = await tx.lead.findFirst({
        where: { id: args.leadId, deletedAt: null, ...leadScopeWhere(args.scope) },
        select: { id: true, preferredFacilityId: true, status: true, contactedAt: true },
      });
      if (!lead) {
        throw new NotFoundException({ code: 'lead_not_found', message: 'Contacto no encontrado' });
      }
      const facilityId = args.input.facilityId ?? lead.preferredFacilityId;
      if (facilityId) {
        const facility = await tx.facility.findFirst({
          where: { id: facilityId, deletedAt: null },
          select: { id: true },
        });
        if (!facility) {
          throw new BadRequestException({ code: 'facility_not_found', message: 'Local no válido' });
        }
      }
      await assertTeamMember(tx, args.input.userId);
      const visit = await tx.leadVisit.create({
        data: {
          tenantId: args.tenantId,
          leadId: args.leadId,
          facilityId: facilityId ?? null,
          scheduledAt: new Date(args.input.scheduledAt),
          notes: args.input.notes?.trim() || null,
          userId: args.input.userId ?? args.userId,
          createdByUserId: args.userId,
        },
        include,
      });
      // Programar una visita es atenderle; y un contacto que viene a verlo, va en serio.
      await tx.lead.update({
        where: { id: args.leadId },
        data: {
          returnedAt: null,
          nurtureStep: 3,
          ...(lead.contactedAt ? {} : { contactedAt: new Date() }),
          ...(lead.status === 'new' || lead.status === 'contacted'
            ? { status: 'qualified', qualifiedAt: new Date() }
            : {}),
        },
      });
      return visit;
    }, args.tenantId);
    if (row.userId && row.userId !== args.userId) {
      await this.notifications
        .create(args.tenantId, {
          type: 'lead.visit_assigned',
          title: `Te han asignado una visita: ${leadDisplayName(row.lead)}`,
          body: row.scheduledAt.toLocaleString('es-ES', { timeZone: 'Europe/Madrid' }),
          link: `/leads?lead=${row.leadId}`,
          userId: row.userId,
          facilityId: row.facilityId,
        })
        .catch(() => undefined);
    }
    return toDto(row);
  }

  /**
   * Cambiar fecha, notas o responsable, o marcarla hecha / no vino /
   * cancelada. Al marcarla hecha queda un seguimiento para mañana.
   */
  async update(args: {
    tenantId: string;
    userId: string;
    id: string;
    input: UpdateLeadVisitInput;
    scope?: FacilityScope;
  }): Promise<LeadVisitDto> {
    const row = await this.prisma.withTenant(async (tx) => {
      const existing = await tx.leadVisit.findFirst({
        where: { id: args.id, lead: { deletedAt: null, ...leadScopeWhere(args.scope) } },
        select: { id: true, leadId: true, status: true, facilityId: true },
      });
      if (!existing) throw this.notFound();
      await assertTeamMember(tx, args.input.userId);
      const visit = await tx.leadVisit.update({
        where: { id: args.id },
        data: {
          ...(args.input.status ? { status: args.input.status } : {}),
          ...(args.input.scheduledAt
            ? { scheduledAt: new Date(args.input.scheduledAt), reminderSentAt: null }
            : {}),
          ...(args.input.notes !== undefined ? { notes: args.input.notes?.trim() || null } : {}),
          ...(args.input.userId !== undefined ? { userId: args.input.userId } : {}),
        },
        include,
      });
      const newStatus = args.input.status;
      if (newStatus && newStatus !== existing.status && newStatus !== 'scheduled') {
        await tx.leadActivity.create({
          data: {
            tenantId: args.tenantId,
            leadId: existing.leadId,
            userId: args.userId,
            type: 'visit',
            content:
              newStatus === 'done'
                ? `Vino a ver el local${visit.notes ? ` — ${visit.notes}` : ''}`
                : newStatus === 'no_show'
                  ? 'No vino a la visita'
                  : 'Visita cancelada',
          },
        });
      }
      if (newStatus === 'done' && existing.status !== 'done') {
        const tz = await this.admin.tenant.findUnique({
          where: { id: args.tenantId },
          select: { timezone: true },
        });
        const due = todayInTimezone(tz?.timezone ?? 'Europe/Madrid');
        due.setUTCDate(due.getUTCDate() + 1);
        await tx.leadFollowup.create({
          data: {
            tenantId: args.tenantId,
            leadId: existing.leadId,
            userId: args.userId,
            assignedToUserId: visit.userId ?? args.userId,
            title: 'Llamar tras la visita: ¿reserva?',
            dueDate: due,
          },
        });
      }
      return visit;
    }, args.tenantId);
    return toDto(row);
  }

  async remove(tenantId: string, id: string, scope?: FacilityScope): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      const { count } = await tx.leadVisit.deleteMany({
        where: { id, lead: { deletedAt: null, ...leadScopeWhere(scope) } },
      });
      if (count === 0) throw this.notFound();
    }, tenantId);
  }

  /**
   * Recordatorio por correo al contacto el día antes de su visita (una vez).
   */
  async sendReminders(now: Date = new Date()): Promise<number> {
    const due = await this.admin.leadVisit.findMany({
      where: {
        status: 'scheduled',
        reminderSentAt: null,
        scheduledAt: {
          gte: new Date(now.getTime() + REMIND_FROM_H * HOUR),
          lte: new Date(now.getTime() + REMIND_TO_H * HOUR),
        },
        lead: { deletedAt: null, email: { not: null } },
        tenant: { deletedAt: null, status: { in: ['active', 'trial'] } },
      },
      include: {
        lead: { select: { email: true, firstName: true, companyName: true } },
        facility: {
          select: {
            name: true,
            address: true,
            city: true,
            timezone: true,
          },
        },
        tenant: { select: { name: true, timezone: true } },
      },
      take: 200,
    });
    let sent = 0;
    for (const v of due) {
      const { count } = await this.admin.leadVisit.updateMany({
        where: { id: v.id, reminderSentAt: null },
        data: { reminderSentAt: now },
      });
      if (count === 0) continue;
      const tz = v.facility?.timezone ?? v.tenant.timezone;
      const when = `${formatDateLong(v.scheduledAt, tz)} a las ${v.scheduledAt.toLocaleTimeString(
        'es-ES',
        { timeZone: tz, hour: '2-digit', minute: '2-digit' },
      )}`;
      const name = v.lead.firstName ?? v.lead.companyName ?? '';
      const where = v.facility
        ? `${v.facility.name}${v.facility.address ? `, ${v.facility.address}` : ''}${
            v.facility.city ? ` (${v.facility.city})` : ''
          }`
        : null;
      await this.communications
        .enqueue({
          tenantId: v.tenantId,
          channel: 'email',
          recipient: v.lead.email!,
          subject: `Te esperamos mañana${v.facility ? ` en ${v.facility.name}` : ''}`,
          bodyText: `Hola${name ? ` ${name}` : ''}:\n\nTe recordamos tu visita: ${when}${
            where ? `\n${where}` : ''
          }.\n\nSi no puedes venir, responde a este correo y buscamos otro momento.\n\n${v.tenant.name}`,
          leadId: v.leadId,
          source: 'lead.visit_reminder',
        })
        .catch(() => undefined);
      sent += 1;
    }
    return sent;
  }
}
