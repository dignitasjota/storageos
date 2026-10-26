import { Injectable } from '@nestjs/common';

import { optionalFacilityWhere, resolveFacilityFilter } from '../../common/facility-scope';
import { todayInTimezone } from '../../common/format';
import { PrismaService } from '../database/prisma.service';

import type { Prisma } from '@storageos/database';
import type { TodayDto, TodayItemDto } from '@storageos/shared';

/** Días en mantenimiento o bloqueado a partir de los que se avisa. */
const OUT_OF_SERVICE_DAYS = 7;
const SOON_DAYS = 30; // contratos que vencen pronto
const RESERVATION_SOON_DAYS = 7;
const MARKETING_RENEWAL_SOON_DAYS = 7;
const TAKE = 8;

function customerName(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

/**
 * Bandeja operativa «Hoy»: agrega en una sola llamada lo que el equipo debe
 * atender hoy (tareas vencidas, contratos/reservas que vencen, incidencias,
 * facturas vencidas, cambios y mensajes pendientes). Todo con `withTenant` (RLS).
 */
@Injectable()
export class TodayService {
  constructor(private readonly prisma: PrismaService) {}

  async getToday(
    tenantId: string,
    facilityId?: string,
    facilityScope: string[] | null = null,
    userId: string | null = null,
  ): Promise<TodayDto> {
    // Local elegido dentro de los del usuario (un local ajeno no devuelve nada).
    const ids = resolveFacilityFilter(facilityScope, facilityId);
    const fac = ids === null ? { in: [] as string[] } : ids ? { in: ids } : undefined;
    const facOwn = optionalFacilityWhere(facilityScope, facilityId) ?? { facilityId: { in: [] } };
    const now = new Date();
    const tenantRow = await this.prisma.withTenant(
      (tx) =>
        tx.tenant.findFirst({
          where: { id: tenantId },
          select: { timezone: true, leadResponseHours: true },
        }),
      tenantId,
    );
    // «Hoy» es el día de calendario del negocio, no el del servidor (UTC):
    // de madrugada en España el día UTC va por detrás. Las columnas de fecha
    // (@db.Date) se comparan con la medianoche UTC de ese día.
    const startOfToday = todayInTimezone(tenantRow?.timezone ?? 'Europe/Madrid', now);
    const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
    const startOfTomorrow = addDays(startOfToday, 1);
    const contractsLimit = addDays(startOfToday, SOON_DAYS);
    const reservationsLimit = new Date(now.getTime() + RESERVATION_SOON_DAYS * 86_400_000);
    const marketingRenewalsLimit = addDays(startOfToday, MARKETING_RENEWAL_SOON_DAYS);
    const today = { gte: startOfToday, lt: startOfTomorrow };
    // Un contrato activo con renovación automática se prorroga solo al llegar a
    // su fecha: no se va ni hay que renovarlo a mano.
    const leaving = { OR: [{ status: 'ending' as const }, { autoRenew: false }] };
    // Vencida = marcada como tal o emitida con el vencimiento ya pasado (el cron
    // las marca de madrugada; hasta entonces no salían en ningún lado).
    const overdueInvoice = {
      kind: 'invoice' as const,
      deletedAt: null,
      OR: [
        { status: 'overdue' as const },
        { status: 'issued' as const, dueDate: { lt: startOfToday } },
      ],
    };
    const customerSelect = {
      select: { customerType: true, firstName: true, lastName: true, companyName: true },
    } as const;

    // Filtro por local: las secciones ancladas a un local (entradas/salidas,
    // firmas, contratos, reservas, facturas, tareas, incidencias) se acotan al
    // `facilityId` elegido; las de empresa (leads, seguimientos, mensajes,
    // cambios) se dejan a nivel tenant. `contract → unit.facilityId`,
    // `reservation → unit.facilityId`, `invoice → contract.unit.facilityId`,
    // y task/incident tienen `facilityId` propio.
    const facContract = fac ? { unit: { is: { facilityId: fac } } } : {};
    const facTaskIncident = facOwn;
    const facInvoice = fac ? { contract: { is: { unit: { is: { facilityId: fac } } } } } : {};
    const depositToRegisterWhere = {
      status: { in: ['active', 'ending'] as ('active' | 'ending')[] },
      deletedAt: null,
      depositAmount: { gt: 0 },
      depositStatus: 'held' as const,
      depositRegisteredAt: null,
      unit: {
        is: {
          unitType: { is: { propertyKind: 'housing' } },
          ...(fac ? { facilityId: fac } : {}),
        },
      },
    };
    const depositToCollectWhere = {
      kind: 'deposit_receipt' as const,
      status: { in: ['issued' as const, 'overdue' as const] },
      bundledWithInvoiceId: null,
      deletedAt: null,
      contract: {
        is: {
          status: { in: ['draft' as const, 'active' as const, 'ending' as const] },
          ...(fac ? { unit: { is: { facilityId: fac } } } : {}),
        },
      },
    };

    return this.prisma.withTenant(async (tx) => {
      const [
        tasks,
        tasksCount,
        moveIns,
        moveInsCount,
        moveOuts,
        moveOutsCount,
        followups,
        followupsCount,
        leads,
        leadsCount,
        signatures,
        signaturesCount,
        contracts,
        contractsCount,
        reservations,
        reservationsCount,
        dueTodayAgg,
        dueTodayCount,
        invoicesAgg,
        invoicesCount,
        incidentsOpen,
        unitChangesPending,
        unreadMessages,
        collectionsDeadlines,
        collectionsDeadlinesCount,
        depositsToSettle,
        depositsToSettleCount,
        depositsToCollect,
        depositsToCollectCount,
        marketingRenewals,
        marketingRenewalsCount,
        retentionOffers,
        retentionOffersCount,
        depositsToRegister,
        depositsToRegisterCount,
      ] = await Promise.all([
        tx.task.findMany({
          where: {
            status: { in: ['open', 'in_progress'] },
            dueDate: { not: null, lt: startOfTomorrow },
            ...facTaskIncident,
          },
          orderBy: [{ dueDate: 'asc' }],
          take: TAKE,
          select: { id: true, title: true, dueDate: true, priority: true },
        }),
        tx.task.count({
          where: {
            status: { in: ['open', 'in_progress'] },
            dueDate: { not: null, lt: startOfTomorrow },
            ...facTaskIncident,
          },
        }),
        // Entradas de hoy: contratos que empiezan hoy.
        tx.contract.findMany({
          where: { status: { in: ['active', 'ending'] }, startDate: today, ...facContract },
          orderBy: [{ startDate: 'asc' }],
          take: TAKE,
          include: { customer: customerSelect, unit: { select: { code: true } } },
        }),
        tx.contract.count({
          where: { status: { in: ['active', 'ending'] }, startDate: today, ...facContract },
        }),
        // Salidas de hoy: contratos que terminan hoy.
        tx.contract.findMany({
          where: {
            status: { in: ['active', 'ending'] },
            endDate: today,
            ...leaving,
            ...facContract,
          },
          orderBy: [{ endDate: 'asc' }],
          take: TAKE,
          include: { customer: customerSelect, unit: { select: { code: true } } },
        }),
        tx.contract.count({
          where: {
            status: { in: ['active', 'ending'] },
            endDate: today,
            ...leaving,
            ...facContract,
          },
        }),
        // Seguimientos CRM vencidos o para hoy.
        tx.customerFollowup.findMany({
          where: { status: 'pending', dueDate: { lt: startOfTomorrow } },
          orderBy: [{ dueDate: 'asc' }],
          take: TAKE,
          include: { customer: customerSelect },
        }),
        tx.customerFollowup.count({
          where: { status: 'pending', dueDate: { lt: startOfTomorrow } },
        }),
        // Leads nuevos sin contactar.
        tx.lead.findMany({
          where: { status: 'new', deletedAt: null },
          orderBy: [{ createdAt: 'desc' }],
          take: TAKE,
          select: {
            id: true,
            firstName: true,
            lastName: true,
            companyName: true,
            source: true,
            createdAt: true,
          },
        }),
        tx.lead.count({ where: { status: 'new', deletedAt: null } }),
        // Firmas pendientes: token de firma vigente sin firmar.
        tx.contract.findMany({
          where: {
            status: 'draft',
            deletedAt: null,
            signedAt: null,
            signingTokenHash: { not: null },
            signingTokenExpiresAt: { gte: now },
            ...facContract,
          },
          orderBy: [{ signingTokenExpiresAt: 'asc' }],
          take: TAKE,
          include: { customer: customerSelect, unit: { select: { code: true } } },
        }),
        tx.contract.count({
          where: {
            status: 'draft',
            deletedAt: null,
            signedAt: null,
            signingTokenHash: { not: null },
            signingTokenExpiresAt: { gte: now },
            ...facContract,
          },
        }),
        tx.contract.findMany({
          where: {
            status: { in: ['active', 'ending'] },
            endDate: { not: null, gte: startOfToday, lte: contractsLimit },
            ...leaving,
            ...facContract,
          },
          orderBy: [{ endDate: 'asc' }],
          take: TAKE,
          include: { customer: customerSelect, unit: { select: { code: true } } },
        }),
        tx.contract.count({
          where: {
            status: { in: ['active', 'ending'] },
            endDate: { not: null, gte: startOfToday, lte: contractsLimit },
            ...leaving,
            ...facContract,
          },
        }),
        tx.reservation.findMany({
          where: {
            status: 'pending',
            validUntil: { gte: now, lte: reservationsLimit },
            ...facContract,
          },
          orderBy: [{ validUntil: 'asc' }],
          take: TAKE,
          include: { customer: customerSelect, unit: { select: { code: true } } },
        }),
        tx.reservation.count({
          where: {
            status: 'pending',
            validUntil: { gte: now, lte: reservationsLimit },
            ...facContract,
          },
        }),
        // Facturas que vencen hoy.
        tx.invoice.aggregate({
          where: {
            kind: 'invoice',
            deletedAt: null,
            status: 'issued',
            dueDate: today,
            ...facInvoice,
          },
          _sum: { total: true, amountPaid: true },
        }),
        tx.invoice.count({
          where: {
            kind: 'invoice',
            deletedAt: null,
            status: 'issued',
            dueDate: today,
            ...facInvoice,
          },
        }),
        tx.invoice.aggregate({
          where: { ...overdueInvoice, ...facInvoice },
          _sum: { total: true, amountPaid: true },
        }),
        tx.invoice.count({ where: { ...overdueInvoice, ...facInvoice } }),
        tx.incident.count({
          where: {
            status: { in: ['reported', 'investigating'] },
            deletedAt: null,
            ...facTaskIncident,
          },
        }),
        tx.unitChangeRequest.count({ where: { status: 'pending' } }),
        this.unreadForUser(tx, tenantId, userId),
        // Expedientes de impago con el plazo del requerimiento vencido.
        tx.delinquencyCase.findMany({
          where: {
            status: 'final_notice',
            finalNoticeDeadline: { lte: now },
            ...(fac ? { facilityId: fac } : {}),
          },
          orderBy: [{ finalNoticeDeadline: 'asc' }],
          take: TAKE,
          include: { customer: customerSelect, unit: { select: { code: true } } },
        }),
        tx.delinquencyCase.count({
          where: {
            status: 'final_notice',
            finalNoticeDeadline: { lte: now },
            ...(fac ? { facilityId: fac } : {}),
          },
        }),
        // Fianzas retenidas sin liquidar de contratos ya finalizados/cancelados.
        tx.contract.findMany({
          where: {
            status: { in: ['ended', 'cancelled'] },
            depositStatus: 'held',
            depositAmount: { gt: 0 },
            ...facContract,
          },
          orderBy: [{ endedAt: 'asc' }, { cancelledAt: 'asc' }],
          take: TAKE,
          include: { customer: customerSelect, unit: { select: { code: true } } },
        }),
        tx.contract.count({
          where: {
            status: { in: ['ended', 'cancelled'] },
            depositStatus: 'held',
            depositAmount: { gt: 0 },
            ...facContract,
          },
        }),
        // Fianzas a cobrar en el local (efectivo): justificante sin pagar y
        // fuera del pago online, de un contrato vivo.
        tx.invoice.findMany({
          where: depositToCollectWhere,
          orderBy: [{ issueDate: 'asc' }],
          take: TAKE,
          select: {
            id: true,
            total: true,
            issueDate: true,
            customer: customerSelect,
            contract: { select: { id: true, unit: { select: { code: true } } } },
          },
        }),
        tx.invoice.count({ where: depositToCollectWhere }),
        // Canales de marketing activos que renuevan (suscripción/anuncio) pronto.
        tx.marketingChannel.findMany({
          where: {
            deletedAt: null,
            status: 'active',
            renewsOn: { not: null, gte: startOfToday, lte: marketingRenewalsLimit },
            ...facTaskIncident,
          },
          orderBy: [{ renewsOn: 'asc' }],
          take: TAKE,
          select: { id: true, name: true, renewsOn: true, monthlyCost: true },
        }),
        tx.marketingChannel.count({
          where: {
            deletedAt: null,
            status: 'active',
            renewsOn: { not: null, gte: startOfToday, lte: marketingRenewalsLimit },
            ...facTaskIncident,
          },
        }),
        // Ofertas de retención (contraoferta de baja) esperando respuesta del inquilino.
        tx.retentionOffer.findMany({
          where: {
            status: 'pending',
            OR: [{ validUntil: null }, { validUntil: { gte: now } }],
            ...(fac ? { contract: { is: { unit: { is: { facilityId: fac } } } } } : {}),
          },
          orderBy: [{ validUntil: 'asc' }],
          take: TAKE,
          include: {
            customer: customerSelect,
            contract: { select: { unit: { select: { code: true } } } },
          },
        }),
        tx.retentionOffer.count({
          where: {
            status: 'pending',
            OR: [{ validUntil: null }, { validUntil: { gte: now } }],
            ...(fac ? { contract: { is: { unit: { is: { facilityId: fac } } } } } : {}),
          },
        }),
        // Viviendas con la fianza cobrada y aún sin depositar en el organismo.
        tx.contract.findMany({
          where: depositToRegisterWhere,
          orderBy: [{ signedAt: 'asc' }],
          take: TAKE,
          include: { customer: customerSelect, unit: { select: { code: true } } },
        }),
        tx.contract.count({ where: depositToRegisterWhere }),
      ]);

      const totalPending =
        Number(invoicesAgg._sum.total ?? 0) - Number(invoicesAgg._sum.amountPaid ?? 0);
      const totalDueToday =
        Number(dueTodayAgg._sum.total ?? 0) - Number(dueTodayAgg._sum.amountPaid ?? 0);

      const contractItem = (c: {
        id: string;
        endDate: Date | null;
        startDate?: Date | undefined;
        customer: Parameters<typeof customerName>[0];
        unit: { code: string } | null;
      }): TodayItemDto => ({
        id: c.id,
        label: customerName(c.customer),
        detail: c.unit?.code ?? null,
        date: (c.startDate ?? c.endDate ?? null)?.toISOString() ?? null,
      });

      const taskItems: TodayItemDto[] = tasks.map((t) => ({
        id: t.id,
        label: t.title,
        detail: t.priority,
        date: t.dueDate ? t.dueDate.toISOString() : null,
        overdue: t.dueDate ? t.dueDate < startOfToday : false,
      }));
      const followupItems: TodayItemDto[] = followups.map((f) => ({
        id: f.id,
        label: f.title,
        detail: customerName(f.customer),
        date: f.dueDate.toISOString(),
        overdue: f.dueDate < startOfToday,
        linkId: f.customerId,
      }));
      const leadItems: TodayItemDto[] = leads.map((l) => ({
        id: l.id,
        label: customerName({ ...l, customerType: l.companyName ? 'business' : 'individual' }),
        detail: l.source,
        date: l.createdAt.toISOString(),
      }));
      const signatureItems: TodayItemDto[] = signatures.map((c) => ({
        id: c.id,
        label: customerName(c.customer),
        detail: c.unit?.code ?? null,
        date: c.signingTokenExpiresAt ? c.signingTokenExpiresAt.toISOString() : null,
      }));

      const responseHours = tenantRow?.leadResponseHours ?? 4;
      const unattendedWhere = {
        status: 'new' as const,
        contactedAt: null,
        deletedAt: null,
        createdAt: { lte: new Date(Date.now() - responseHours * 3_600_000) },
      };
      const [leadFollowups, leadFollowupsCount, unattended, unattendedCount] = await Promise.all([
        tx.leadFollowup.findMany({
          where: { status: 'pending', dueDate: { lt: startOfTomorrow }, lead: { deletedAt: null } },
          orderBy: [{ dueDate: 'asc' }],
          take: TAKE,
          include: { lead: { select: { firstName: true, lastName: true, companyName: true } } },
        }),
        tx.leadFollowup.count({
          where: { status: 'pending', dueDate: { lt: startOfTomorrow }, lead: { deletedAt: null } },
        }),
        tx.lead.findMany({
          where: unattendedWhere,
          orderBy: [{ createdAt: 'asc' }],
          take: TAKE,
          select: {
            id: true,
            firstName: true,
            lastName: true,
            companyName: true,
            source: true,
            createdAt: true,
          },
        }),
        tx.lead.count({ where: unattendedWhere }),
      ]);
      // Inventario: stock bajo, trasteros parados y documentos que caducan.
      const outOfServiceCut = new Date(now.getTime() - OUT_OF_SERVICE_DAYS * 86_400_000);
      const docsLimit = new Date(now.getTime() + 30 * 86_400_000);
      const [stocks, parked, docs] = await Promise.all([
        tx.productStock.findMany({
          where: {
            product: { deletedAt: null, isActive: true, minStock: { not: null } },
            facility: { deletedAt: null },
            ...(fac ? { facilityId: fac } : {}),
          },
          select: {
            quantity: true,
            productId: true,
            product: { select: { name: true, minStock: true } },
            facility: { select: { name: true } },
          },
        }),
        tx.unit.findMany({
          where: {
            status: { in: ['maintenance', 'blocked'] },
            facility: { deletedAt: null },
            ...(fac ? { facilityId: fac } : {}),
          },
          select: {
            id: true,
            code: true,
            status: true,
            maintenanceUntil: true,
            createdAt: true,
            facility: { select: { name: true } },
            statusHistory: {
              orderBy: { occurredAt: 'desc' },
              take: 1,
              select: { occurredAt: true },
            },
          },
        }),
        tx.facilityDocument.findMany({
          where: {
            expiresOn: { not: null, lte: docsLimit },
            facility: { deletedAt: null },
            ...(fac ? { facilityId: fac } : {}),
          },
          orderBy: { expiresOn: 'asc' },
          select: {
            id: true,
            facilityId: true,
            name: true,
            expiresOn: true,
            facility: { select: { name: true } },
          },
        }),
      ]);
      const low = stocks.filter((st) => st.quantity < (st.product.minStock ?? 0));
      const stuck = parked
        .map((u) => ({ ...u, since: u.statusHistory[0]?.occurredAt ?? u.createdAt }))
        .filter(
          (u) =>
            (u.maintenanceUntil && u.maintenanceUntil < startOfToday) || u.since < outOfServiceCut,
        )
        .sort((a, b) => a.since.getTime() - b.since.getTime());

      const leadLabel = (l: {
        firstName: string | null;
        lastName: string | null;
        companyName: string | null;
      }) =>
        l.companyName || [l.firstName, l.lastName].filter(Boolean).join(' ').trim() || 'Contacto';

      const urgentCount =
        tasksCount +
        followupsCount +
        leadFollowupsCount +
        unattendedCount +
        moveInsCount +
        moveOutsCount +
        dueTodayCount +
        invoicesCount +
        collectionsDeadlinesCount +
        depositsToSettleCount +
        depositsToCollectCount +
        depositsToRegisterCount +
        marketingRenewalsCount +
        retentionOffersCount +
        docs.filter((d) => d.expiresOn! < startOfToday).length;

      return {
        date: startOfToday.toISOString(),
        urgentCount,
        moveInsToday: {
          count: moveInsCount,
          items: moveIns.map((c) => contractItem({ ...c, startDate: c.startDate })),
        },
        moveOutsToday: {
          count: moveOutsCount,
          items: moveOuts.map((c) => contractItem({ ...c, startDate: undefined })),
        },
        tasksDue: { count: tasksCount, items: taskItems },
        followupsDue: { count: followupsCount, items: followupItems },
        leadFollowupsDue: {
          count: leadFollowupsCount,
          items: leadFollowups.map((f) => ({
            id: f.id,
            label: f.title,
            detail: leadLabel(f.lead),
            date: f.dueDate.toISOString(),
            overdue: f.dueDate < startOfToday,
            linkId: f.leadId,
          })),
        },
        unattendedLeads: {
          count: unattendedCount,
          items: unattended.map((l) => ({
            id: l.id,
            label: leadLabel(l),
            detail: l.source,
            date: l.createdAt.toISOString(),
            overdue: true,
            linkId: l.id,
          })),
        },
        newLeads: { count: leadsCount, items: leadItems },
        signaturesPending: { count: signaturesCount, items: signatureItems },
        contractsEndingSoon: {
          count: contractsCount,
          items: contracts.map((c) => contractItem({ ...c, startDate: undefined })),
        },
        reservationsExpiring: {
          count: reservationsCount,
          items: reservations.map((r) => ({
            id: r.id,
            label: r.customer ? customerName(r.customer) : 'Reserva',
            detail: r.unit?.code ?? null,
            date: r.validUntil.toISOString(),
          })),
        },
        invoicesDueToday: { count: dueTodayCount, totalDue: Math.max(0, totalDueToday) },
        invoicesOverdue: { count: invoicesCount, totalPending: Math.max(0, totalPending) },
        collectionsDeadlines: {
          count: collectionsDeadlinesCount,
          items: collectionsDeadlines.map((c) => ({
            id: c.id,
            label: customerName(c.customer),
            detail: c.unit?.code ?? null,
            date: c.finalNoticeDeadline?.toISOString() ?? null,
            overdue: true,
          })),
        },
        depositsToSettle: {
          count: depositsToSettleCount,
          items: depositsToSettle.map((c) => ({
            id: c.id,
            label: customerName(c.customer),
            detail: c.unit?.code ?? null,
            date: (c.endedAt ?? c.cancelledAt ?? null)?.toISOString() ?? null,
          })),
        },
        depositsToCollect: {
          count: depositsToCollectCount,
          items: depositsToCollect.map((d) => ({
            id: d.id,
            linkId: d.contract?.id ?? null,
            label: d.customer ? customerName(d.customer) : 'Fianza',
            detail: `${d.contract?.unit?.code ?? ''} · ${Number(d.total).toFixed(2)} €`,
            date: d.issueDate ? d.issueDate.toISOString() : null,
          })),
        },
        depositsToRegister: {
          count: depositsToRegisterCount,
          items: depositsToRegister.map((c) => ({
            id: c.id,
            linkId: c.id,
            label: customerName(c.customer),
            detail: `${c.unit.code} · fianza ${Number(c.depositAmount).toFixed(2)} €`,
            date: c.signedAt ? c.signedAt.toISOString() : null,
            // El plazo habitual para depositarla es de un mes desde la firma.
            overdue: !!c.signedAt && c.signedAt.getTime() < now.getTime() - 30 * 86_400_000,
          })),
        },
        incidentsOpen,
        unitChangesPending,
        unreadMessages,
        marketingRenewalsDue: {
          count: marketingRenewalsCount,
          items: marketingRenewals.map((c) => ({
            id: c.id,
            label: c.name,
            detail: c.monthlyCost !== null ? `${Number(c.monthlyCost)}€/mes` : null,
            date: c.renewsOn ? c.renewsOn.toISOString() : null,
          })),
        },
        retentionOffersPending: {
          count: retentionOffersCount,
          // `id` = el contrato (no hay página propia de la oferta; vive como
          // card dentro de la ficha del contrato), mismo patrón que `depositsToSettle`.
          items: retentionOffers.map((r) => ({
            id: r.contractId,
            label: customerName(r.customer),
            detail: r.contract.unit?.code ?? null,
            date: r.validUntil ? r.validUntil.toISOString() : null,
          })),
        },
        lowStock: {
          count: low.length,
          // `id` = el producto (se abre su stock en Productos).
          items: low.slice(0, TAKE).map((st) => ({
            id: st.productId,
            label: st.product.name,
            detail: `${st.facility.name}: quedan ${st.quantity} (mínimo ${st.product.minStock})`,
            date: null,
          })),
        },
        unitsOutOfService: {
          count: stuck.length,
          items: stuck.slice(0, TAKE).map((u) => ({
            id: u.id,
            label: u.code,
            detail: `${u.facility.name} · ${u.status === 'maintenance' ? 'mantenimiento' : 'bloqueado'} desde hace ${Math.floor((now.getTime() - u.since.getTime()) / 86_400_000)} días`,
            date: u.maintenanceUntil ? u.maintenanceUntil.toISOString() : null,
            overdue: !!u.maintenanceUntil && u.maintenanceUntil < startOfToday,
          })),
        },
        facilityDocumentsExpiring: {
          count: docs.length,
          items: docs.slice(0, TAKE).map((d) => ({
            id: d.id,
            label: d.name,
            detail: d.facility.name,
            date: d.expiresOn!.toISOString(),
            overdue: d.expiresOn! < startOfToday,
            linkId: d.facilityId,
          })),
        },
      };
    }, tenantId);
  }

  /**
   * Mensajes de inquilinos que este usuario no ha leído (leído por usuario,
   * como la bandeja «Mensajes» y el aviso del menú). Sin usuario, ninguno.
   */
  private async unreadForUser(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string | null,
  ): Promise<number> {
    if (!userId) return 0;
    const rows = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM customer_messages m
      JOIN customers c ON c.id = m.customer_id AND c.deleted_at IS NULL
      LEFT JOIN customer_message_reads r
        ON r.customer_id = m.customer_id AND r.user_id = ${userId}::uuid
      WHERE m.tenant_id = ${tenantId}::uuid
        AND m.sender_type = 'customer'
        AND m.created_at > COALESCE(
          r.last_read_at,
          (SELECT u.created_at FROM users u WHERE u.id = ${userId}::uuid)
        )`;
    return rows[0]?.n ?? 0;
  }
}
