import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  PLATFORM_LEAD_LOST_REASON_LABELS,
  platformLeadName,
  type PlatformLeadLostReason,
  type SalesRecoveryDto,
  type SalesTodayRowDto,
  type UpdateSalesArchiveInput,
} from '@storageos/shared';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { ARCHIVE_CLEAR, PlatformLeadsService } from '../leads/platform-leads.service';
import { SuperAdminAuditService } from '../super-admin-audit.service';

import { SalesAssignmentService } from './sales-assignment.service';
import { madridToday, type SalesActor } from './sales-common';
import { SalesNotifyService } from './sales-notify.service';

import type { Prisma } from '@storageos/database';

const dayLabel = (iso: string) => iso.split('-').reverse().join('/');
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Archivado de un comercial (perdido con la marca de archivado). */
export function archivedWhere(repId?: string): Prisma.PlatformLeadWhereInput {
  return {
    ...(repId ? { salesRepId: repId } : { salesRepId: { not: null } }),
    discardedAt: null,
    status: 'lost',
    salesArchivedAt: { not: null },
  };
}

/** Archivados cuya fecha de volver a intentarlo ya ha llegado. */
export function dueWhere(today: string, repId?: string): Prisma.PlatformLeadWhereInput {
  return {
    ...archivedWhere(repId),
    doNotContact: false,
    salesRecoverOn: { lte: new Date(`${today}T00:00:00Z`) },
  };
}

/**
 * No interesados y recuperación: el comercial vuelve a trabajar un archivado
 * («Recuperar»), cambia su fecha o lo marca «No volver a contactar». Cuando
 * llega la fecha, se le avisa (o a la dirección si ya no está activo).
 */
@Injectable()
export class SalesRecoveryService {
  private readonly logger = new Logger(SalesRecoveryService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly leads: PlatformLeadsService,
    private readonly assignment: SalesAssignmentService,
    private readonly notify: SalesNotifyService,
    private readonly audit: SuperAdminAuditService,
  ) {}

  private leadActor(actor: SalesActor) {
    return {
      superAdminId: actor.repId,
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    };
  }

  private async archivedOf(repId: string, leadId: string) {
    const lead = await this.assignment.leadOf(repId, leadId);
    if (lead.status !== 'lost' || !lead.salesArchivedAt) {
      throw new BadRequestException({
        code: 'not_archived',
        message: 'No está entre tus archivados',
      });
    }
    return lead;
  }

  /**
   * «Recuperar»: vuelve a su cartera activa con todo su historial. Un
   * prospecto vuelve a «Contactado»; un cliente dado de baja sigue sin cuenta
   * de pago hasta que vuelva a contratar.
   */
  async recover(repId: string, leadId: string, actor: SalesActor): Promise<void> {
    const lead = await this.archivedOf(repId, leadId);
    const now = new Date();
    await this.admin.platformLead.update({
      where: { id: leadId },
      data: { doNotContact: false, salesSeenAt: lead.salesSeenAt ?? now },
    });
    if (lead.tenantId && lead.lostReasonCode === 'churned') {
      await this.admin.platformLead.update({ where: { id: leadId }, data: ARCHIVE_CLEAR });
      await this.leads.addActivity(
        leadId,
        'system',
        'Recuperado: vuelve a la cartera activa para intentar que vuelva a contratar',
        actor.repId,
      );
    } else {
      await this.leads.reopen(leadId, this.leadActor(actor));
      await this.admin.platformLead.update({ where: { id: leadId }, data: ARCHIVE_CLEAR });
      await this.leads.addActivity(
        leadId,
        'system',
        'Recuperado: vuelve a la cartera activa',
        actor.repId,
      );
    }
    const open = await this.admin.salesRecovery.findFirst({
      where: { leadId, recoveredAt: null, wonAt: null },
      orderBy: { archivedAt: 'desc' },
      select: { id: true },
    });
    if (open) {
      await this.admin.salesRecovery.update({
        where: { id: open.id },
        data: { recoveredAt: now },
      });
    }
    await this.audit.record({
      superAdminId: actor.repId,
      action: 'admin.sales.lead_recovered',
      targetType: lead.tenantId ? 'tenant' : 'platform_lead',
      targetId: lead.tenantId ?? leadId,
      targetTenantId: lead.tenantId,
      changes: { leadId },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    });
  }

  /** Cambia la fecha de volver a intentarlo o lo marca «No volver a contactar» (o lo quita). */
  async updateArchive(
    repId: string,
    leadId: string,
    input: UpdateSalesArchiveInput,
    actor: SalesActor,
  ): Promise<void> {
    const lead = await this.archivedOf(repId, leadId);
    const now = new Date();
    const doNotContact = input.doNotContact ?? lead.doNotContact;
    let recoverOn: string | null;
    if (doNotContact) {
      recoverOn = null;
    } else if (input.recoverOn !== undefined) {
      recoverOn = input.recoverOn;
    } else if (lead.doNotContact) {
      // Deja de ser «No volver a contactar»: la fecha que toca por su motivo.
      recoverOn = await this.leads.proposedRecoverOn(
        (lead.lostReasonCode as PlatformLeadLostReason | null) ?? 'other',
        now,
      );
    } else {
      recoverOn = lead.salesRecoverOn ? isoDay(lead.salesRecoverOn) : null;
    }
    if (recoverOn) this.leads.assertRecoverDay(recoverOn, now);
    const recoverDate = recoverOn ? new Date(`${recoverOn}T00:00:00Z`) : null;
    await this.admin.platformLead.update({
      where: { id: leadId },
      data: {
        salesRecoverOn: recoverDate,
        salesRecoverNotifiedAt: null,
        doNotContact,
        ...(doNotContact ? { sequenceOptOut: true } : {}),
      },
    });
    if (doNotContact && !lead.doNotContact) {
      await this.leads.closePendingFollowups(leadId, now);
      await this.leads.stopSalesCadence(leadId, now);
      await this.leads.stopSequence(leadId, 'manual');
    }
    const open = await this.admin.salesRecovery.findFirst({
      where: { leadId, recoveredAt: null, wonAt: null },
      orderBy: { archivedAt: 'desc' },
      select: { id: true },
    });
    if (open) {
      await this.admin.salesRecovery.update({
        where: { id: open.id },
        data: { recoverOn: recoverDate },
      });
    }
    await this.leads.addActivity(
      leadId,
      'system',
      doNotContact
        ? 'Archivado: no volver a contactar'
        : recoverOn
          ? `Archivado: volver a intentarlo el ${dayLabel(recoverOn)}`
          : 'Archivado sin fecha para volver a intentarlo',
      actor.repId,
    );
    await this.audit.record({
      superAdminId: actor.repId,
      action: 'admin.sales.archive_updated',
      targetType: lead.tenantId ? 'tenant' : 'platform_lead',
      targetId: lead.tenantId ?? leadId,
      targetTenantId: lead.tenantId,
      changes: { leadId, recoverOn, doNotContact },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    });
  }

  /** «Para recuperar» del «Hoy» del comercial. */
  async todayRows(repId: string, now = new Date()): Promise<SalesTodayRowDto[]> {
    const rows = await this.admin.platformLead.findMany({
      where: dueWhere(madridToday(now), repId),
      orderBy: [{ salesRecoverOn: 'asc' }, { id: 'asc' }],
      take: 50,
      select: {
        id: true,
        tenantId: true,
        companyName: true,
        contactName: true,
        email: true,
        lostReasonCode: true,
        salesRecoverOn: true,
      },
    });
    return rows.map((r) => {
      const reason = r.lostReasonCode as PlatformLeadLostReason | null;
      const day = r.salesRecoverOn ? isoDay(r.salesRecoverOn) : null;
      return {
        leadId: r.id,
        tenantId: r.tenantId,
        name: platformLeadName(r),
        detail: [
          day ? `Volver a intentarlo desde el ${dayLabel(day)}` : 'Para recuperar',
          reason ? PLATFORM_LEAD_LOST_REASON_LABELS[reason] : null,
        ]
          .filter(Boolean)
          .join(' · '),
        date: day,
      };
    });
  }

  /**
   * Cada mañana: los archivados a los que ya les toca. Un aviso por comercial
   * con la lista; si el comercial ya no está activo, el aviso va a la
   * dirección. Cada archivado se avisa una vez por fecha. Devuelve cuántos.
   */
  async notifyDue(now = new Date()): Promise<number> {
    const rows = await this.admin.platformLead.findMany({
      where: { ...dueWhere(madridToday(now)), salesRecoverNotifiedAt: null },
      orderBy: { salesRecoverOn: 'asc' },
      take: 2000,
      select: {
        id: true,
        salesRepId: true,
        companyName: true,
        contactName: true,
        email: true,
        salesRep: { select: { fullName: true, isActive: true, role: true } },
      },
    });
    if (rows.length === 0) return 0;
    // Se reserva el aviso: con dos réplicas no sale dos veces.
    const claimed: typeof rows = [];
    for (const r of rows) {
      const { count } = await this.admin.platformLead.updateMany({
        where: { id: r.id, salesRecoverNotifiedAt: null },
        data: { salesRecoverNotifiedAt: now },
      });
      if (count === 1) claimed.push(r);
    }
    const byRep = new Map<string, typeof rows>();
    for (const r of claimed) {
      const list = byRep.get(r.salesRepId!) ?? [];
      list.push(r);
      byRep.set(r.salesRepId!, list);
    }
    const list = (items: typeof rows) => {
      const shown = items.slice(0, 15).map((l) => `· ${platformLeadName(l)}`);
      return [
        ...shown,
        ...(items.length > shown.length ? [`… y ${items.length - shown.length} más.`] : []),
      ];
    };
    for (const items of byRep.values()) {
      const rep = items[0]!.salesRep;
      const n = items.length;
      if (rep?.isActive && rep.role === 'sales') {
        await this.notify.rep(items[0]!.salesRepId!, {
          type: 'sales.recover_due',
          title:
            n === 1
              ? `Toca volver a intentarlo con ${platformLeadName(items[0]!)}`
              : `Tienes ${n} prospectos para recuperar`,
          body: [
            'Ya ha llegado la fecha que dejaste para volver a intentarlo. Están en «Para recuperar» de tu «Hoy»:',
            ...list(items),
          ].join('\n'),
          link: n === 1 ? `/admin/sales/accounts/${items[0]!.id}` : '/admin/sales',
        });
      } else {
        await this.notify.team({
          type: 'sales.recover_due',
          title:
            n === 1
              ? `Un archivado de ${rep?.fullName ?? 'un comercial'} ya toca recuperarlo`
              : `${n} archivados de ${rep?.fullName ?? 'un comercial'} ya toca recuperarlos`,
          body: [
            `${rep?.fullName ?? 'Su comercial'} ya no está activo: decide quién los intenta recuperar.`,
            ...list(items),
          ].join('\n'),
          link: '/admin/sales-team',
        });
      }
    }
    if (claimed.length) this.logger.log(`[sales] para recuperar: ${claimed.length}`);
    return claimed.length;
  }

  /** Archivados y recuperaciones de todo el equipo (o de un comercial), para la dirección. */
  async list(filter: { repId?: string; take?: number } = {}): Promise<SalesRecoveryDto[]> {
    const rows = await this.admin.salesRecovery.findMany({
      where: filter.repId ? { repId: filter.repId } : {},
      orderBy: { archivedAt: 'desc' },
      take: Math.min(Math.max(filter.take ?? 200, 1), 1000),
      include: {
        rep: { select: { fullName: true, isActive: true } },
        lead: { select: { companyName: true, contactName: true, email: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      leadId: r.leadId,
      leadName: platformLeadName(r.lead),
      repId: r.repId,
      repName: r.rep.fullName,
      repActive: r.rep.isActive,
      kind: r.kind === 'client' ? 'client' : 'prospect',
      reasonCode: (r.reasonCode as PlatformLeadLostReason | null) ?? null,
      archivedAt: r.archivedAt.toISOString(),
      recoverOn: r.recoverOn ? isoDay(r.recoverOn) : null,
      recoveredAt: r.recoveredAt?.toISOString() ?? null,
      wonAt: r.wonAt?.toISOString() ?? null,
    }));
  }
}
