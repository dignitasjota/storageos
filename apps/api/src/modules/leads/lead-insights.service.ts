import { Injectable, NotFoundException } from '@nestjs/common';
import {
  LEAD_STATUS_LABELS,
  leadSourceLabel,
  type LeadFunnelReportDto,
  type LeadFunnelRowDto,
  type LeadStatusValue,
  type LeadSummaryDto,
  type LeadTimelineItemDto,
} from '@storageos/shared';

import { type FacilityScope } from '../../common/facility-scope';
import { formatEur } from '../../common/format';
import { leadScopeWhere } from '../../common/lead-scope';
import { PrismaService } from '../database/prisma.service';

import { leadListWhere, type LeadListFilters } from './leads.service';

const DAY = 86_400_000;
const LEAD_STATUSES: LeadStatusValue[] = ['new', 'contacted', 'qualified', 'won', 'lost'];

const COMM_SOURCE_LABELS: Record<string, string> = {
  'lead.reply': 'Correo del equipo',
  'lead.quote': 'Presupuesto por correo',
  'lead.quote_reminder': 'Recordatorio del presupuesto',
  'lead.visit_reminder': 'Recordatorio de la visita',
  'lead.nurture_1': 'Correo automático: precios',
  'lead.nurture_2': 'Correo automático: ¿te ayudamos?',
  'lead.nurture_3': 'Correo automático: último',
};

const STATUS_ACTIONS = LEAD_STATUSES.map((s) => `lead.${s}`);

function emptyRow(key: string, label: string): LeadFunnelRowDto {
  return {
    key,
    label,
    leads: 0,
    contacted: 0,
    qualified: 0,
    won: 0,
    lost: 0,
    conversionPct: null,
    avgDaysToWin: null,
  };
}

/** Cronología, totales del tablero e informe del embudo de contactos. */
@Injectable()
export class LeadInsightsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Todo lo que ha pasado con un contacto: correos (con su entrega),
   * respuestas, WhatsApp, chat de la web, actividad, presupuestos, visitas,
   * seguimientos y cambios de fase. Del más reciente al más antiguo.
   */
  async timeline(
    tenantId: string,
    leadId: string,
    scope?: FacilityScope,
  ): Promise<LeadTimelineItemDto[]> {
    return this.prisma.withTenant(async (tx) => {
      const lead = await tx.lead.findFirst({
        where: { id: leadId, deletedAt: null, ...leadScopeWhere(scope) },
        select: { id: true, createdAt: true, source: true, message: true },
      });
      if (!lead) {
        throw new NotFoundException({ code: 'lead_not_found', message: 'Contacto no encontrado' });
      }
      const [comms, waConvs, chatConvs, activities, quotes, visits, followups, audits] =
        await Promise.all([
          tx.communication.findMany({
            where: { leadId },
            orderBy: { createdAt: 'desc' },
            take: 100,
            select: {
              id: true,
              channel: true,
              status: true,
              subject: true,
              bodyText: true,
              source: true,
              createdAt: true,
              sentAt: true,
              errorMessage: true,
            },
          }),
          tx.whatsappConversation.findMany({ where: { leadId }, select: { id: true } }),
          tx.webChatConversation.findMany({ where: { leadId }, select: { id: true } }),
          tx.leadActivity.findMany({
            where: { leadId },
            orderBy: { occurredAt: 'desc' },
            take: 100,
            include: { user: { select: { fullName: true } } },
          }),
          tx.leadQuote.findMany({
            where: { leadId },
            orderBy: { sentAt: 'desc' },
            take: 50,
            include: {
              facility: { select: { name: true } },
              unitType: { select: { name: true } },
              sentBy: { select: { fullName: true } },
            },
          }),
          tx.leadVisit.findMany({
            where: { leadId },
            orderBy: { scheduledAt: 'desc' },
            take: 50,
            include: {
              facility: { select: { name: true } },
              createdBy: { select: { fullName: true } },
            },
          }),
          tx.leadFollowup.findMany({
            where: { leadId },
            orderBy: { createdAt: 'desc' },
            take: 50,
            include: { user: { select: { fullName: true } } },
          }),
          tx.auditLog.findMany({
            where: { entityType: 'Lead', entityId: leadId, action: { in: STATUS_ACTIONS } },
            orderBy: { occurredAt: 'desc' },
            take: 50,
            include: { user: { select: { fullName: true } } },
          }),
        ]);
      const [waMessages, chatMessages] = await Promise.all([
        waConvs.length
          ? tx.whatsappMessage.findMany({
              where: { conversationId: { in: waConvs.map((c) => c.id) } },
              orderBy: { createdAt: 'desc' },
              take: 100,
              include: { sentBy: { select: { fullName: true } } },
            })
          : [],
        chatConvs.length
          ? tx.webChatMessage.findMany({
              where: { conversationId: { in: chatConvs.map((c) => c.id) } },
              orderBy: { createdAt: 'desc' },
              take: 100,
              include: { senderUser: { select: { fullName: true } } },
            })
          : [],
      ]);

      const items: LeadTimelineItemDto[] = [
        {
          id: `created-${lead.id}`,
          kind: 'created',
          at: lead.createdAt.toISOString(),
          title: `Llegó por ${leadSourceLabel(lead.source)}`,
          body: lead.message,
          by: null,
          status: null,
        },
      ];
      for (const c of comms) {
        items.push({
          id: c.id,
          kind: c.channel === 'whatsapp' ? 'whatsapp_out' : 'email_out',
          at: (c.sentAt ?? c.createdAt).toISOString(),
          title: (c.source && COMM_SOURCE_LABELS[c.source]) ?? c.subject ?? 'Correo',
          body: c.subject && c.source && COMM_SOURCE_LABELS[c.source] ? c.subject : null,
          by: null,
          status: c.status === 'failed' && c.errorMessage ? `failed: ${c.errorMessage}` : c.status,
        });
      }
      for (const m of waMessages) {
        items.push({
          id: m.id,
          kind: m.direction === 'in' ? 'whatsapp_in' : 'whatsapp_out',
          at: m.createdAt.toISOString(),
          title:
            m.direction === 'in'
              ? 'Escribió por WhatsApp'
              : m.sender === 'assistant'
                ? 'Respondió el asistente (WhatsApp)'
                : 'Respuesta por WhatsApp',
          body: m.body,
          by: m.sentBy?.fullName ?? null,
          status: m.direction === 'out' ? m.status : null,
        });
      }
      for (const m of chatMessages) {
        items.push({
          id: m.id,
          kind: m.role === 'visitor' ? 'webchat_in' : 'webchat_out',
          at: m.createdAt.toISOString(),
          title:
            m.role === 'visitor'
              ? 'Escribió en el chat de la web'
              : m.role === 'assistant'
                ? 'Respondió el asistente (web)'
                : 'Respuesta en el chat de la web',
          body: m.content,
          by: m.senderUser?.fullName ?? null,
          status: null,
        });
      }
      for (const a of activities) {
        items.push({
          id: a.id,
          kind: a.type === 'email_in' ? 'email_in' : 'activity',
          at: a.occurredAt.toISOString(),
          title: a.type === 'email_in' ? 'Respondió por correo' : activityTitle(a.type),
          body: a.content,
          by: a.user?.fullName ?? null,
          status: null,
        });
      }
      for (const q of quotes) {
        items.push({
          id: q.id,
          kind: 'quote',
          at: q.sentAt.toISOString(),
          title: `Presupuesto${q.channel === 'whatsapp' ? ' por WhatsApp' : ''}: ${formatEur(
            Number(q.totalToPay),
          )}`,
          body: [q.unitType?.name, q.facility?.name, q.months > 1 ? `${q.months} meses` : null]
            .filter(Boolean)
            .join(' · '),
          by: q.sentBy?.fullName ?? null,
          status: q.bookedAt ? 'booked' : q.reminderSentAt ? 'reminded' : null,
        });
      }
      for (const v of visits) {
        items.push({
          id: v.id,
          kind: 'visit',
          at: v.scheduledAt.toISOString(),
          title: `Visita${v.facility ? ` a ${v.facility.name}` : ''}`,
          body: v.notes,
          by: v.createdBy?.fullName ?? null,
          status: v.status,
        });
      }
      for (const f of followups) {
        items.push({
          id: f.id,
          kind: 'followup',
          at: (f.completedAt ?? f.createdAt).toISOString(),
          title:
            f.status === 'done'
              ? `Seguimiento hecho: ${f.title}`
              : `Seguimiento para el ${f.dueDate.toLocaleDateString('es-ES', {
                  day: 'numeric',
                  month: 'long',
                  timeZone: 'UTC',
                })}: ${f.title}`,
          body: f.outcome ?? f.note,
          by: f.user?.fullName ?? null,
          status: f.status,
        });
      }
      for (const a of audits) {
        const status = a.action.slice('lead.'.length) as LeadStatusValue;
        const reason = (a.changes as Record<string, unknown> | null)?.reason;
        items.push({
          id: a.id,
          kind: 'status',
          at: a.occurredAt.toISOString(),
          title: `Pasó a «${LEAD_STATUS_LABELS[status] ?? status}»`,
          body: typeof reason === 'string' ? reason : null,
          by: a.user?.fullName ?? null,
          status,
        });
      }
      items.sort((a, b) => b.at.localeCompare(a.at));
      return items.slice(0, 300);
    }, tenantId);
  }

  /**
   * Cuántos contactos hay en cada fase y cuánto sumarían al mes (su
   * presupuesto o, si no lo dijo, el precio del tamaño que busca).
   */
  async summary(tenantId: string, filters: LeadListFilters): Promise<LeadSummaryDto> {
    const { status: _status, page: _page, ...rest } = filters;
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.lead.findMany({
          where: leadListWhere(rest),
          select: {
            status: true,
            budgetMonthly: true,
            preferredUnitType: { select: { defaultPriceMonthly: true } },
          },
          take: 10_000,
        }),
      tenantId,
    );
    const byStatus: LeadSummaryDto['byStatus'] = Object.fromEntries(
      LEAD_STATUSES.map((s) => [s, { count: 0, value: 0 }]),
    );
    for (const r of rows) {
      const b = byStatus[r.status] ?? (byStatus[r.status] = { count: 0, value: 0 });
      b.count += 1;
      const v = r.budgetMonthly ?? r.preferredUnitType?.defaultPriceMonthly ?? null;
      if (v != null) b.value = Math.round((b.value + Number(v)) * 100) / 100;
    }
    return { byStatus };
  }

  /**
   * Embudo de los contactos que llegaron entre dos fechas, por origen, por
   * responsable y por local: cuántos se contactaron, se cualificaron, se
   * ganaron y cuánto tardaron.
   */
  async report(
    tenantId: string,
    range: { from: string; to: string },
    scope?: FacilityScope,
  ): Promise<LeadFunnelReportDto> {
    const end = new Date(`${range.to}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.lead.findMany({
          where: {
            deletedAt: null,
            ...leadScopeWhere(scope),
            createdAt: { gte: new Date(`${range.from}T00:00:00Z`), lt: end },
          },
          select: {
            source: true,
            status: true,
            contactedAt: true,
            qualifiedAt: true,
            wonAt: true,
            createdAt: true,
            assignedToUserId: true,
            assignedTo: { select: { fullName: true } },
            preferredFacilityId: true,
            preferredFacility: { select: { name: true } },
          },
          take: 20_000,
        }),
      tenantId,
    );
    const totals = emptyRow('all', 'Todos');
    const bySource = new Map<string, LeadFunnelRowDto>();
    const byUser = new Map<string, LeadFunnelRowDto>();
    const byFacility = new Map<string, LeadFunnelRowDto>();
    const winDays = new Map<LeadFunnelRowDto, number[]>();
    const add = (row: LeadFunnelRowDto, r: (typeof rows)[number]) => {
      row.leads += 1;
      if (r.contactedAt || ['contacted', 'qualified', 'won'].includes(r.status)) row.contacted += 1;
      if (r.qualifiedAt || ['qualified', 'won'].includes(r.status)) row.qualified += 1;
      if (r.status === 'won') {
        row.won += 1;
        if (r.wonAt) {
          const list = winDays.get(row) ?? [];
          list.push((r.wonAt.getTime() - r.createdAt.getTime()) / DAY);
          winDays.set(row, list);
        }
      }
      if (r.status === 'lost') row.lost += 1;
    };
    const bucket = (map: Map<string, LeadFunnelRowDto>, key: string, label: string) => {
      let row = map.get(key);
      if (!row) map.set(key, (row = emptyRow(key, label)));
      return row;
    };
    for (const r of rows) {
      add(totals, r);
      add(bucket(bySource, r.source, leadSourceLabel(r.source)), r);
      add(
        bucket(byUser, r.assignedToUserId ?? 'none', r.assignedTo?.fullName ?? 'Sin responsable'),
        r,
      );
      add(
        bucket(
          byFacility,
          r.preferredFacilityId ?? 'none',
          r.preferredFacility?.name ?? 'Sin local',
        ),
        r,
      );
    }
    const finish = (row: LeadFunnelRowDto) => {
      row.conversionPct = row.leads ? Math.round((row.won / row.leads) * 1000) / 10 : null;
      const days = winDays.get(row);
      row.avgDaysToWin = days?.length
        ? Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) / 10
        : null;
      return row;
    };
    const sorted = (map: Map<string, LeadFunnelRowDto>) =>
      [...map.values()].map(finish).sort((a, b) => b.leads - a.leads);
    return {
      from: range.from,
      to: range.to,
      totals: finish(totals),
      bySource: sorted(bySource),
      byUser: sorted(byUser),
      byFacility: sorted(byFacility),
    };
  }
}

function activityTitle(type: string): string {
  switch (type) {
    case 'call':
      return 'Llamada';
    case 'visit':
      return 'Visita';
    case 'meeting':
      return 'Reunión';
    case 'whatsapp':
      return 'WhatsApp';
    case 'email':
      return 'Correo';
    case 'note':
      return 'Nota';
    default:
      return 'Actividad';
  }
}
