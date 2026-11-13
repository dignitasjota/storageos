import { Injectable } from '@nestjs/common';
import { leadSourceLabel } from '@storageos/shared';

import {
  invoiceFacilityWhere,
  optionalFacilityWhere,
  resolveFacilityFilter,
} from '../../common/facility-scope';
import { formatEur, todayInTimezone } from '../../common/format';
import { CONFIRMED_START_WHERE } from '../../common/pre-opening';
import { NO_PAYMENT_IN_FLIGHT, PAYABLE_INVOICE_WHERE } from '../../common/sepa-remittance-guard';
import { tenantFeatures } from '../../common/tenant-features';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import { overdueInvoiceWhere } from './today-filters';

import type { Prisma } from '@storageos/database';
import type { Permission, TodayDto, TodayItemDto, TenantTodaySnoozeKind } from '@storageos/shared';

/** Días en mantenimiento o bloqueado a partir de los que se avisa. */
const OUT_OF_SERVICE_DAYS = 7;
const SOON_DAYS = 30; // contratos que vencen pronto
const RESERVATION_SOON_DAYS = 7;
const MARKETING_RENEWAL_SOON_DAYS = 7;
/** Locales que abren en estos días o menos salen en «Hoy». */
const PRE_OPENING_SOON_DAYS = 7;
const TAKE = 8;
/** Entradas y salidas del día, y el modo mostrador: la lista entera. */
const TAKE_FULL = 50;
/** Con todas las secciones hay unas 50 consultas: más margen que los 5 s de Prisma. */
const TODAY_TX_TIMEOUT_MS = 20_000;

const TASK_PRIORITY_LABELS: Record<string, string> = {
  low: 'Baja',
  normal: 'Normal',
  high: 'Alta',
  urgent: 'Urgente',
};

export interface TodayOptions {
  facilityId?: string | undefined;
  facilityScope?: string[] | null;
  userId?: string | null;
  mine?: boolean;
  /** Permisos de quien lo pide: cada apartado solo sale con su permiso de lectura. */
  permissions: readonly Permission[];
  /** Listas enteras en vez de las 8 primeras (modo mostrador). */
  full?: boolean;
}

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
const RGPD_REQUEST_LABELS: Record<string, string> = {
  access: 'Pide sus datos',
  rectification: 'Pide corregir sus datos',
  erasure: 'Pide borrar sus datos',
  portability: 'Pide llevarse sus datos',
  restriction: 'Pide limitar el uso de sus datos',
};

/** Vencimientos del negocio que salen en «Hoy»: los vencidos y los de 7 días. */
const REMINDERS_SOON_DAYS = 7;

@Injectable()
export class TodayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
  ) {}

  async getToday(tenantId: string, options: TodayOptions): Promise<TodayDto> {
    const { facilityId, userId = null, mine = false, permissions } = options;
    const facilityScope = options.facilityScope ?? null;
    const TAKE_LIST = options.full ? TAKE_FULL : TAKE;
    const can = (p: Permission) => permissions.includes(p);
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
    // Vencimientos del negocio (función de los planes de pago).
    const remindersOn = (await tenantFeatures(this.admin, tenantId)).includes('business_reminders');
    const startOfTomorrow = addDays(startOfToday, 1);
    const contractsLimit = addDays(startOfToday, SOON_DAYS);
    const reservationsLimit = new Date(now.getTime() + RESERVATION_SOON_DAYS * 86_400_000);
    const marketingRenewalsLimit = addDays(startOfToday, MARKETING_RENEWAL_SOON_DAYS);
    const today = { gte: startOfToday, lt: startOfTomorrow };
    // Un contrato activo con renovación automática se prorroga solo al llegar a
    // su fecha: no se va ni hay que renovarlo a mano.
    const leaving = { OR: [{ status: 'ending' as const }, { autoRenew: false }] };
    const overdueInvoice = overdueInvoiceWhere(startOfToday);
    const customerSelect = {
      select: {
        customerType: true,
        firstName: true,
        lastName: true,
        companyName: true,
        phone: true,
      },
    } as const;

    // Lo que el equipo ha apartado no sale ni cuenta hasta su fecha.
    const snoozes = await this.prisma.withTenant(
      (tx) =>
        tx.todaySnooze.findMany({
          where: { until: { gt: now } },
          select: { kind: true, refId: true },
        }),
      tenantId,
    );
    const snoozedIds = (kind: TenantTodaySnoozeKind) =>
      snoozes.filter((x) => x.kind === kind).map((x) => x.refId);
    const notSnoozed = (kind: TenantTodaySnoozeKind) => {
      const ids = snoozedIds(kind);
      return ids.length > 0 ? { id: { notIn: ids } } : {};
    };
    const debtSnoozed = new Set(snoozedIds('customer_debt'));

    // Filtro por local: las secciones ancladas a un local (entradas/salidas,
    // firmas, contratos, reservas, facturas, tareas, incidencias) se acotan al
    // `facilityId` elegido; las de empresa (leads, seguimientos, mensajes,
    // cambios) se dejan a nivel tenant. `contract → unit.facilityId`,
    // `reservation → unit.facilityId`, `invoice → contract.unit.facilityId`,
    // y task/incident tienen `facilityId` propio.
    const facContract = fac ? { unit: { is: { facilityId: fac } } } : {};
    // «Lo mío»: tareas e incidencias asignadas al usuario, contactos asignados
    // a él y seguimientos que creó. Lo demás (cobros, entradas…) es del local.
    const me = mine && userId ? userId : null;
    const facTaskIncident = me ? { ...facOwn, assignedToUserId: me } : facOwn;
    const mineLead = me ? { assignedToUserId: me } : {};
    const mineFollowup = me ? { userId: me } : {};
    const chargeableTypes: ('card' | 'sepa_debit')[] = ['card', 'sepa_debit'];
    const invoiceItemSelect = {
      id: true,
      invoiceNumber: true,
      total: true,
      amountPaid: true,
      dueDate: true,
      customerId: true,
      // Cobro en marcha: no se reclama ni se vuelve a cobrar.
      payments: {
        where: { status: { in: ['pending', 'processing'] } },
        select: { id: true },
        take: 1,
      },
      sepaRemittanceItems: { where: { status: 'pending' }, select: { id: true }, take: 1 },
      customer: {
        select: {
          customerType: true,
          firstName: true,
          lastName: true,
          companyName: true,
          phone: true,
          // Tarjeta o domiciliación guardada: se puede cobrar desde aquí.
          paymentMethods: {
            where: { deletedAt: null, type: { in: chargeableTypes } },
            select: { id: true },
            take: 1,
          },
        },
      },
    } satisfies Prisma.InvoiceSelect;
    // Mismo alcance que la lista de facturas y que las cifras del mes.
    const facInvoice = (invoiceFacilityWhere(facilityScope, facilityId) ?? {
      id: { in: [] },
    }) as Prisma.InvoiceWhereInput;
    const dueTodayWhere: Prisma.InvoiceWhereInput = {
      AND: [
        { kind: 'invoice', deletedAt: null, status: 'issued', dueDate: today },
        notSnoozed('invoice'),
        facInvoice,
      ],
    };
    const overdueScoped: Prisma.InvoiceWhereInput = {
      AND: [overdueInvoice, notSnoozed('invoice'), facInvoice],
    };
    const taskWhere: Prisma.TaskWhereInput = {
      status: { in: ['open', 'in_progress'] },
      deletedAt: null,
      dueDate: { not: null, lt: startOfTomorrow },
      ...notSnoozed('task'),
      ...facTaskIncident,
    };
    const moveInWhere: Prisma.ContractWhereInput = {
      status: { in: ['active', 'ending'] },
      deletedAt: null,
      startDate: today,
      ...CONFIRMED_START_WHERE,
      ...facContract,
    };
    // Las de hoy y las que se pasaron de fecha sin cerrar (baja automática apagada).
    const moveOutWhere: Prisma.ContractWhereInput = {
      status: { in: ['active', 'ending'] },
      deletedAt: null,
      endDate: { not: null, lt: startOfTomorrow },
      ...leaving,
      ...facContract,
    };
    const endingSoonWhere: Prisma.ContractWhereInput = {
      status: { in: ['active', 'ending'] },
      deletedAt: null,
      endDate: { not: null, gte: startOfTomorrow, lte: contractsLimit },
      ...leaving,
      ...facContract,
    };
    const signatureWhere: Prisma.ContractWhereInput = {
      status: 'draft',
      deletedAt: null,
      signedAt: null,
      signingTokenHash: { not: null },
      signingTokenExpiresAt: { gte: now },
      ...facContract,
    };
    // Fianzas que hay que liquidar de verdad: las que se cobraron. Una reserva
    // cancelada sin pagar también queda como «retenida», pero no hay nada que devolver.
    const depositToSettleWhere: Prisma.ContractWhereInput = {
      status: { in: ['ended', 'cancelled'] },
      deletedAt: null,
      depositStatus: 'held',
      depositAmount: { gt: 0 },
      ...notSnoozed('deposit'),
      ...facContract,
      OR: [
        {
          invoices: {
            some: { kind: 'deposit_receipt', deletedAt: null, status: 'paid' },
          },
        },
        {
          invoices: {
            some: {
              deletedAt: null,
              status: 'paid',
              items: { some: { description: { startsWith: 'Fianza' } } },
            },
          },
        },
        {
          events: { some: { eventType: 'signed', payload: { path: ['migrated'], equals: true } } },
        },
        {
          status: 'ended',
          invoices: {
            none: {
              kind: 'deposit_receipt',
              deletedAt: null,
              status: { in: ['draft', 'issued', 'overdue'] },
            },
          },
        },
      ],
    };
    const unitChangesWhere: Prisma.UnitChangeRequestWhereInput = {
      status: 'pending',
      ...(fac
        ? facilityId
          ? { contract: { is: { unit: { is: { facilityId: fac } } } } }
          : {
              OR: [
                { contract: { is: { unit: { is: { facilityId: fac } } } } },
                { contractId: null },
              ],
            }
        : {}),
    };
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
      AND: [
        // También la que espera al pago de su reserva.
        PAYABLE_INVOICE_WHERE,
        // También la de quien eligió pagarlo todo en el local.
        {
          OR: [
            { bundledWithInvoiceId: null },
            { contract: { is: { offlinePaymentMethod: 'cash' as const } } },
          ],
        },
      ],
      deletedAt: null,
      contract: {
        is: {
          status: { in: ['draft' as const, 'active' as const, 'ending' as const] },
          ...(fac ? { unit: { is: { facilityId: fac } } } : {}),
        },
      },
    };

    return this.prisma.withTenant(
      async (tx) => {
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
          dueTodayRows,
          overdueRows,
          incidentsOpen,
          unitChangesPending,
          unread,
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
          rgpdRequests,
          incidentsReported,
          dueTodayActionable,
          depositsToRegisterLate,
          activePlans,
        ] = await Promise.all([
          tx.task.findMany({
            where: taskWhere,
            orderBy: [{ dueDate: 'asc' }],
            take: TAKE_LIST,
            select: { id: true, title: true, dueDate: true, priority: true },
          }),
          tx.task.count({ where: taskWhere }),
          // Entradas de hoy: contratos que empiezan hoy.
          tx.contract.findMany({
            where: moveInWhere,
            orderBy: [{ startDate: 'asc' }],
            take: TAKE_FULL,
            include: { customer: customerSelect, unit: { select: { code: true } } },
          }),
          tx.contract.count({ where: moveInWhere }),
          tx.contract.findMany({
            where: moveOutWhere,
            orderBy: [{ endDate: 'asc' }],
            take: TAKE_FULL,
            include: { customer: customerSelect, unit: { select: { code: true } } },
          }),
          tx.contract.count({ where: moveOutWhere }),
          // Seguimientos CRM vencidos o para hoy.
          tx.customerFollowup.findMany({
            where: {
              status: 'pending',
              dueDate: { lt: startOfTomorrow },
              ...notSnoozed('customer_followup'),
              ...mineFollowup,
            },
            orderBy: [{ dueDate: 'asc' }],
            take: TAKE_LIST,
            include: { customer: customerSelect },
          }),
          tx.customerFollowup.count({
            where: {
              status: 'pending',
              dueDate: { lt: startOfTomorrow },
              ...notSnoozed('customer_followup'),
              ...mineFollowup,
            },
          }),
          // Leads nuevos sin contactar.
          tx.lead.findMany({
            where: { status: 'new', deletedAt: null, ...notSnoozed('lead'), ...mineLead },
            orderBy: [{ createdAt: 'desc' }],
            take: TAKE,
            select: {
              id: true,
              firstName: true,
              lastName: true,
              companyName: true,
              phone: true,
              source: true,
              createdAt: true,
            },
          }),
          tx.lead.count({
            where: { status: 'new', deletedAt: null, ...notSnoozed('lead'), ...mineLead },
          }),
          // Firmas pendientes: token de firma vigente sin firmar.
          tx.contract.findMany({
            where: signatureWhere,
            orderBy: [{ signingTokenExpiresAt: 'asc' }],
            take: TAKE_LIST,
            include: { customer: customerSelect, unit: { select: { code: true } } },
          }),
          tx.contract.count({ where: signatureWhere }),
          tx.contract.findMany({
            where: endingSoonWhere,
            orderBy: [{ endDate: 'asc' }],
            take: TAKE,
            include: { customer: customerSelect, unit: { select: { code: true } } },
          }),
          tx.contract.count({ where: endingSoonWhere }),
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
          tx.invoice.aggregate({ where: dueTodayWhere, _sum: { total: true, amountPaid: true } }),
          tx.invoice.count({ where: dueTodayWhere }),
          tx.invoice.aggregate({ where: overdueScoped, _sum: { total: true, amountPaid: true } }),
          tx.invoice.count({ where: overdueScoped }),
          tx.invoice.findMany({
            where: dueTodayWhere,
            orderBy: [{ total: 'desc' }],
            take: TAKE_LIST,
            select: invoiceItemSelect,
          }),
          tx.invoice.findMany({
            where: overdueScoped,
            orderBy: [{ dueDate: 'asc' }],
            take: TAKE,
            select: invoiceItemSelect,
          }),
          tx.incident.count({
            where: {
              status: { in: ['reported', 'investigating'] },
              deletedAt: null,
              ...facTaskIncident,
            },
          }),
          tx.unitChangeRequest.count({ where: unitChangesWhere }),
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
          // Fianzas cobradas y sin liquidar de contratos ya finalizados/cancelados.
          tx.contract.findMany({
            where: depositToSettleWhere,
            orderBy: [{ endedAt: 'asc' }, { cancelledAt: 'asc' }],
            take: TAKE,
            include: { customer: customerSelect, unit: { select: { code: true } } },
          }),
          tx.contract.count({ where: depositToSettleWhere }),
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
              ...facOwn,
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
              ...facOwn,
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
          // Solicitudes de protección de datos sin cerrar que vencen en 7 días.
          tx.dataSubjectRequest.findMany({
            where: {
              status: { in: ['open', 'in_progress'] },
              dueAt: { lt: new Date(now.getTime() + 7 * 86_400_000) },
            },
            orderBy: [{ dueAt: 'asc' }],
            take: 20,
            select: { id: true, email: true, requestType: true, dueAt: true },
          }),
          tx.incident.count({ where: { status: 'reported', deletedAt: null, ...facTaskIncident } }),
          tx.invoice.count({ where: { AND: [dueTodayWhere, NO_PAYMENT_IN_FLIGHT] } }),
          tx.contract.count({
            where: {
              ...depositToRegisterWhere,
              signedAt: { lt: new Date(now.getTime() - 30 * 86_400_000) },
            },
          }),
          tx.paymentPlan.findMany({ where: { status: 'active' }, select: { invoiceIds: true } }),
        ]);

        // La deuda vencida es un asunto por inquilino, no por factura; lo que ya
        // se está cobrando o va en un plan de pagos no pide nada hoy.
        const planInvoiceIds = new Set(activePlans.flatMap((p) => p.invoiceIds));
        const overdueGroups = await tx.invoice.groupBy({
          by: ['customerId'],
          where: {
            AND: [overdueScoped, NO_PAYMENT_IN_FLIGHT, { id: { notIn: [...planInvoiceIds] } }],
          },
        });

        const overdueCustomers = overdueGroups.filter(
          (g) => !g.customerId || !debtSnoozed.has(g.customerId),
        );
        const invoiceItem = (i: (typeof overdueRows)[number], overdue: boolean): TodayItemDto => {
          const note =
            i.payments.length > 0 || i.sepaRemittanceItems.length > 0
              ? 'Cobro en curso'
              : planInvoiceIds.has(i.id)
                ? 'En plan de pagos'
                : null;
          return {
            id: i.id,
            label: i.customer ? customerName(i.customer) : 'Sin cliente',
            detail: i.invoiceNumber,
            date: i.dueDate ? i.dueDate.toISOString() : null,
            overdue,
            amount: Math.max(0, Math.round((Number(i.total) - Number(i.amountPaid)) * 100) / 100),
            chargeable: !note && (i.customer?.paymentMethods.length ?? 0) > 0,
            note,
            phone: i.customer?.phone ?? null,
            customerId: i.customerId,
          };
        };

        const totalPending =
          Number(invoicesAgg._sum.total ?? 0) - Number(invoicesAgg._sum.amountPaid ?? 0);
        const totalDueToday =
          Number(dueTodayAgg._sum.total ?? 0) - Number(dueTodayAgg._sum.amountPaid ?? 0);

        const contractItem = (c: {
          id: string;
          customerId: string;
          endDate: Date | null;
          startDate?: Date | undefined;
          customer: Parameters<typeof customerName>[0] & { phone: string | null };
          unit: { code: string } | null;
        }): TodayItemDto => ({
          id: c.id,
          label: customerName(c.customer),
          detail: c.unit?.code ?? null,
          date: (c.startDate ?? c.endDate ?? null)?.toISOString() ?? null,
          overdue: !c.startDate && !!c.endDate && c.endDate < startOfToday,
          phone: c.customer.phone,
          customerId: c.customerId,
        });

        const taskItems: TodayItemDto[] = tasks.map((t) => ({
          id: t.id,
          label: t.title,
          detail: TASK_PRIORITY_LABELS[t.priority] ?? t.priority,
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
          phone: f.customer.phone,
          customerId: f.customerId,
        }));
        const leadItems: TodayItemDto[] = leads.map((l) => ({
          id: l.id,
          label: customerName({ ...l, customerType: l.companyName ? 'business' : 'individual' }),
          detail: leadSourceLabel(l.source),
          date: l.createdAt.toISOString(),
          phone: l.phone,
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
          ...notSnoozed('lead'),
          contactedAt: null,
          deletedAt: null,
          createdAt: { lte: new Date(Date.now() - responseHours * 3_600_000) },
          ...mineLead,
        };
        const [leadFollowups, leadFollowupsCount, unattended, unattendedCount] = await Promise.all([
          tx.leadFollowup.findMany({
            where: {
              status: 'pending',
              dueDate: { lt: startOfTomorrow },
              ...notSnoozed('lead_followup'),
              lead: { deletedAt: null, ...mineLead },
            },
            orderBy: [{ dueDate: 'asc' }],
            take: TAKE_LIST,
            include: { lead: { select: { firstName: true, lastName: true, companyName: true } } },
          }),
          tx.leadFollowup.count({
            where: {
              status: 'pending',
              dueDate: { lt: startOfTomorrow },
              ...notSnoozed('lead_followup'),
              lead: { deletedAt: null, ...mineLead },
            },
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
              phone: true,
              source: true,
              createdAt: true,
            },
          }),
          tx.lead.count({ where: unattendedWhere }),
        ]);
        // Inventario: stock bajo, trasteros parados y documentos que caducan.
        const outOfServiceCut = new Date(now.getTime() - OUT_OF_SERVICE_DAYS * 86_400_000);
        const docsLimit = new Date(now.getTime() + 30 * 86_400_000);
        const remindersLimit = addDays(startOfToday, REMINDERS_SOON_DAYS);
        const reminders = remindersOn
          ? await tx.businessReminder.findMany({
              where: {
                status: 'active',
                dueDate: { lte: remindersLimit },
                AND: [
                  facOwn,
                  mine && userId
                    ? { OR: [{ recipientMode: 'managers' }, { recipientUserIds: { has: userId } }] }
                    : {},
                ],
              },
              orderBy: { dueDate: 'asc' },
              select: {
                id: true,
                title: true,
                dueDate: true,
                amount: true,
                facility: { select: { name: true } },
              },
            })
          : [];
        // Gastos por pagar que vencen esta semana o ya vencieron.
        const expensesToPay =
          !me && can('expenses:read')
            ? await tx.expense.findMany({
                where: {
                  paymentStatus: 'pending',
                  dueDate: { lte: remindersLimit },
                  ...facOwn,
                },
                orderBy: { dueDate: 'asc' },
                select: {
                  id: true,
                  description: true,
                  vendor: true,
                  dueDate: true,
                  amount: true,
                  totalAmount: true,
                  facility: { select: { name: true } },
                },
              })
            : [];
        const [stocks, parked, docs, preOpeningFacilities, customerDocs] = await Promise.all([
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
          // Locales por abrir y sus reservas (firmadas, sin empezar).
          tx.facility.findMany({
            where: { deletedAt: null, preOpening: true, ...(fac ? { id: fac } : {}) },
            select: {
              id: true,
              name: true,
              openingDate: true,
              units: {
                select: {
                  contracts: {
                    where: {
                      preOpening: true,
                      preOpeningStartedAt: null,
                      status: { in: ['active', 'ending'] },
                      deletedAt: null,
                    },
                    select: {
                      preOpeningDeadline: true,
                      invoices: {
                        where: { kind: 'invoice', deletedAt: null },
                        select: { status: true },
                      },
                    },
                  },
                },
              },
            },
          }),
          // Solo de quien sigue de inquilino: el DNI caducado de un ex no urge.
          tx.customerDocument.findMany({
            where: {
              expiresAt: { not: null, lte: docsLimit },
              customer: {
                deletedAt: null,
                contracts: {
                  some: { status: { in: ['active', 'ending'] }, deletedAt: null, ...facContract },
                },
              },
            },
            orderBy: { expiresAt: 'asc' },
            select: {
              id: true,
              customerId: true,
              fileName: true,
              expiresAt: true,
              customer: {
                select: {
                  customerType: true,
                  firstName: true,
                  lastName: true,
                  companyName: true,
                },
              },
            },
          }),
        ]);
        const soonLimit = new Date(startOfToday.getTime() + PRE_OPENING_SOON_DAYS * 86_400_000);
        const preOpeningSoon = preOpeningFacilities
          .map((f) => {
            const reservations = f.units.flatMap((u) => u.contracts);
            const unpaid = reservations.filter(
              (c) => !c.invoices.some((i) => i.status === 'paid'),
            ).length;
            const pastDeadline = reservations.filter(
              (c) => c.preOpeningDeadline && c.preOpeningDeadline < startOfToday,
            ).length;
            return { f, reservations: reservations.length, unpaid, pastDeadline };
          })
          .filter(
            (x) => x.pastDeadline > 0 || (x.f.openingDate !== null && x.f.openingDate <= soonLimit),
          )
          .sort((a, b) => (a.f.openingDate?.getTime() ?? 0) - (b.f.openingDate?.getTime() ?? 0));
        const low = stocks.filter((st) => st.quantity < (st.product.minStock ?? 0));
        const stuck = parked
          .map((u) => ({ ...u, since: u.statusHistory[0]?.occurredAt ?? u.createdAt }))
          .filter(
            (u) =>
              (u.maintenanceUntil && u.maintenanceUntil < startOfToday) ||
              u.since < outOfServiceCut,
          )
          .sort((a, b) => a.since.getTime() - b.since.getTime());

        const leadLabel = (l: {
          firstName: string | null;
          lastName: string | null;
          companyName: string | null;
        }) =>
          l.companyName || [l.firstName, l.lastName].filter(Boolean).join(' ').trim() || 'Contacto';

        const n = (p: Permission, value: number) => (can(p) ? value : 0);
        const remindersDue = reminders.filter((r) => r.dueDate <= startOfToday).length;
        const expensesDue = expensesToPay.filter((e) => e.dueDate! <= startOfToday).length;
        // Solo lo que vence hoy o está atrasado y se puede hacer hoy. Con «Lo mío»,
        // solo lo asignado a esa persona.
        const urgentCount = me
          ? n('tasks:read', tasksCount) +
            n('customers:read', followupsCount) +
            n('leads:read', leadFollowupsCount + unattendedCount) +
            n('incidents:read', incidentsReported) +
            n('reminders:read', remindersDue)
          : n('tasks:read', tasksCount) +
            n('customers:read', followupsCount + unread.conversations) +
            n('leads:read', leadFollowupsCount + unattendedCount) +
            n('incidents:read', incidentsReported) +
            moveInsCount +
            moveOutsCount +
            n('invoices:read', dueTodayActionable + overdueCustomers.length) +
            n('collections:read', collectionsDeadlinesCount) +
            depositsToSettleCount +
            depositsToCollectCount +
            depositsToRegisterLate +
            n('rgpd:manage', rgpdRequests.filter((r) => r.dueAt < now).length) +
            n(
              'marketing:read',
              marketingRenewals.filter((c) => c.renewsOn && c.renewsOn <= startOfToday).length,
            ) +
            n('facilities:read', docs.filter((d) => d.expiresOn! < startOfToday).length) +
            n('reminders:read', remindersDue) +
            n('expenses:read', expensesDue) +
            n('facilities:read', preOpeningSoon.filter((x) => x.pastDeadline > 0).length);
        const section = <T extends { count: number; items: TodayItemDto[] }>(
          p: Permission,
          value: T,
          hidden: T,
        ): T => (can(p) ? value : hidden);
        const none = { count: 0, items: [] as TodayItemDto[] };

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
          tasksDue: section('tasks:read', { count: tasksCount, items: taskItems }, none),
          followupsDue: section(
            'customers:read',
            { count: followupsCount, items: followupItems },
            none,
          ),
          leadFollowupsDue: section(
            'leads:read',
            {
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
            none,
          ),
          unattendedLeads: section(
            'leads:read',
            {
              count: unattendedCount,
              items: unattended.map((l) => ({
                id: l.id,
                label: leadLabel(l),
                detail: leadSourceLabel(l.source),
                date: l.createdAt.toISOString(),
                overdue: true,
                phone: l.phone,
                linkId: l.id,
              })),
            },
            none,
          ),
          newLeads: section('leads:read', { count: leadsCount, items: leadItems }, none),
          signaturesPending: { count: signaturesCount, items: signatureItems },
          contractsEndingSoon: {
            count: contractsCount,
            items: contracts.map((c) => contractItem({ ...c, startDate: undefined })),
          },
          reservationsExpiring: section(
            'reservations:read',
            {
              count: reservationsCount,
              items: reservations.map((r) => ({
                id: r.id,
                label: r.customer ? customerName(r.customer) : 'Reserva',
                detail: r.unit?.code ?? null,
                date: r.validUntil.toISOString(),
              })),
            },
            none,
          ),
          invoicesDueToday: section(
            'invoices:read',
            {
              count: dueTodayCount,
              totalDue: Math.max(0, totalDueToday),
              items: dueTodayRows.map((i) => invoiceItem(i, false)),
            },
            { ...none, totalDue: 0 },
          ),
          invoicesOverdue: section(
            'invoices:read',
            {
              count: invoicesCount,
              totalPending: Math.max(0, totalPending),
              items: overdueRows.map((i) => invoiceItem(i, true)),
            },
            { ...none, totalPending: 0 },
          ),
          collectionsDeadlines: section(
            'collections:read',
            {
              count: collectionsDeadlinesCount,
              items: collectionsDeadlines.map((c) => ({
                id: c.id,
                label: customerName(c.customer),
                detail: c.unit?.code ?? null,
                date: c.finalNoticeDeadline?.toISOString() ?? null,
                overdue: true,
              })),
            },
            none,
          ),
          depositsToSettle: {
            count: depositsToSettleCount,
            items: depositsToSettle.map((c) => ({
              id: c.id,
              label: customerName(c.customer),
              detail: c.unit?.code ?? null,
              date: (c.endedAt ?? c.cancelledAt ?? null)?.toISOString() ?? null,
              amount: Number(c.depositAmount),
              phone: c.customer.phone,
            })),
          },
          depositsToCollect: {
            count: depositsToCollectCount,
            items: depositsToCollect.map((d) => ({
              id: d.id,
              linkId: d.contract?.id ?? null,
              label: d.customer ? customerName(d.customer) : 'Fianza',
              detail: `${d.contract?.unit?.code ?? ''} · ${formatEur(Number(d.total))}`,
              date: d.issueDate ? d.issueDate.toISOString() : null,
            })),
          },
          depositsToRegister: {
            count: depositsToRegisterCount,
            items: depositsToRegister.map((c) => ({
              id: c.id,
              linkId: c.id,
              label: customerName(c.customer),
              detail: `${c.unit.code} · fianza ${formatEur(Number(c.depositAmount))}`,
              date: c.signedAt ? c.signedAt.toISOString() : null,
              // El plazo habitual para depositarla es de un mes desde la firma.
              overdue: !!c.signedAt && c.signedAt.getTime() < now.getTime() - 30 * 86_400_000,
            })),
          },
          rgpdRequestsDue: section(
            'rgpd:manage',
            {
              count: rgpdRequests.length,
              items: rgpdRequests.map((r) => ({
                id: r.id,
                label: r.email,
                detail: RGPD_REQUEST_LABELS[r.requestType] ?? r.requestType,
                date: r.dueAt.toISOString(),
                overdue: r.dueAt < now,
              })),
            },
            none,
          ),
          incidentsOpen: n('incidents:read', incidentsOpen),
          unitChangesPending,
          unreadMessages: n('customers:read', unread.messages),
          marketingRenewalsDue: section(
            'marketing:read',
            {
              count: marketingRenewalsCount,
              items: marketingRenewals.map((c) => ({
                id: c.id,
                label: c.name,
                detail: c.monthlyCost !== null ? `${formatEur(Number(c.monthlyCost))}/mes` : null,
                date: c.renewsOn ? c.renewsOn.toISOString() : null,
              })),
            },
            none,
          ),
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
          preOpeningSoon: section(
            'facilities:read',
            {
              count: preOpeningSoon.length,
              // `id` = el local (la fecha de apertura se gestiona en sus ajustes).
              items: preOpeningSoon.slice(0, TAKE).map((x) => ({
                id: x.f.id,
                label: x.f.name,
                detail: [
                  x.f.openingDate
                    ? `Abre el ${x.f.openingDate.toISOString().slice(8, 10)}/${x.f.openingDate.toISOString().slice(5, 7)}`
                    : 'Sin fecha de apertura',
                  `${x.reservations} ${x.reservations === 1 ? 'reserva' : 'reservas'}`,
                  x.unpaid > 0 ? `${x.unpaid} sin pagar` : null,
                  x.pastDeadline > 0
                    ? `${x.pastDeadline} con el plazo máximo vencido (pueden cancelar con devolución total)`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · '),
                date: x.f.openingDate ? x.f.openingDate.toISOString() : null,
                overdue: x.pastDeadline > 0,
              })),
            },
            none,
          ),
          lowStock: section(
            'products:read',
            {
              count: low.length,
              // `id` = el producto (se abre su stock en Productos).
              items: low.slice(0, TAKE).map((st) => ({
                id: st.productId,
                label: st.product.name,
                detail: `${st.facility.name}: quedan ${st.quantity} (mínimo ${st.product.minStock})`,
                date: null,
              })),
            },
            none,
          ),
          unitsOutOfService: section(
            'units:read',
            {
              count: stuck.length,
              items: stuck.slice(0, TAKE).map((u) => ({
                id: u.id,
                label: u.code,
                detail: `${u.facility.name} · ${u.status === 'maintenance' ? 'mantenimiento' : 'bloqueado'} desde hace ${Math.floor((now.getTime() - u.since.getTime()) / 86_400_000)} días`,
                date: u.maintenanceUntil ? u.maintenanceUntil.toISOString() : null,
                overdue: !!u.maintenanceUntil && u.maintenanceUntil < startOfToday,
              })),
            },
            none,
          ),
          businessRemindersDue: section(
            'reminders:read',
            {
              count: reminders.length,
              items: reminders.slice(0, TAKE).map((r) => ({
                id: r.id,
                label: r.title,
                detail:
                  [r.facility?.name, r.amount !== null ? formatEur(Number(r.amount)) : null]
                    .filter(Boolean)
                    .join(' · ') || null,
                date: r.dueDate.toISOString(),
                overdue: r.dueDate < startOfToday,
              })),
            },
            none,
          ),
          expensesToPay: section(
            'expenses:read',
            {
              count: expensesToPay.length,
              items: expensesToPay.slice(0, TAKE).map((e) => ({
                id: e.id,
                label: e.description,
                detail:
                  [e.vendor, e.facility?.name, formatEur(Number(e.totalAmount ?? e.amount))]
                    .filter(Boolean)
                    .join(' · ') || null,
                date: e.dueDate!.toISOString(),
                overdue: e.dueDate! < startOfToday,
              })),
            },
            none,
          ),
          customerDocumentsExpiring: section(
            'customers:read',
            {
              count: customerDocs.length,
              items: customerDocs.slice(0, TAKE).map((d) => ({
                id: d.id,
                label: customerName(d.customer),
                detail: d.fileName,
                date: d.expiresAt!.toISOString(),
                overdue: d.expiresAt! < startOfToday,
                linkId: d.customerId,
              })),
            },
            none,
          ),
          facilityDocumentsExpiring: section(
            'facilities:read',
            {
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
            none,
          ),
        };
      },
      tenantId,
      { timeout: TODAY_TX_TIMEOUT_MS },
    );
  }

  /**
   * Mensajes de inquilinos que este usuario no ha leído (leído por usuario,
   * como la bandeja «Mensajes» y el aviso del menú). Sin usuario, ninguno.
   */
  private async unreadForUser(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string | null,
  ): Promise<{ messages: number; conversations: number }> {
    if (!userId) return { messages: 0, conversations: 0 };
    const rows = await tx.$queryRaw<{ messages: number; conversations: number }[]>`
      SELECT count(*)::int AS messages, count(DISTINCT m.customer_id)::int AS conversations
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
    return rows[0] ?? { messages: 0, conversations: 0 };
  }
}
