import { Injectable, NotFoundException } from '@nestjs/common';
import { NON_CASH_PAYMENT_METHODS } from '@storageos/shared';

import {
  invoiceFacilityWhere,
  optionalFacilityWhere,
  resolveFacilityFilter,
} from '../../common/facility-scope';
import { formatEur, todayInTimezone, zonedDayStart } from '../../common/format';
import { CollectionsOpsService } from '../collections-ops/collections-ops.service';
import { PaymentPlansService } from '../collections-ops/payment-plans.service';
import { PrismaService } from '../database/prisma.service';
import { InventoryService } from '../inventory/inventory.service';

import type { Prisma } from '@storageos/database';
import type {
  CreateTenantTodaySnoozeInput,
  Permission,
  TodayAttentionItemDto,
  TodayAttentionSectionDto,
  TodayDebtDto,
  TodayDoneDto,
  TodayExtrasDto,
  TenantTodaySnoozeDto,
  TenantTodaySnoozeKind,
  TodayTomorrowItemDto,
  TodayWeekItemDto,
} from '@storageos/shared';

const DAY = 86_400_000;
const TAKE = 8;
const TAKE_WEEK = 60;
const TAKE_DEBTS = 10;
const TX_TIMEOUT_MS = 20_000;

const METHOD_LABELS: Record<string, string> = {
  cash: 'Efectivo',
  card: 'Tarjeta',
  sepa_debit: 'Domiciliación',
  bank_transfer: 'Transferencia',
  other: 'Otros',
};

interface PersonName {
  customerType?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
}

function personName(c: PersonName | null | undefined): string {
  if (!c) return 'Sin nombre';
  if (c.customerType === 'business' && c.companyName) return c.companyName;
  const full = `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim();
  return full || c.companyName || 'Sin nombre';
}

export interface TodayExtrasOptions {
  facilityId?: string | undefined;
  facilityScope?: string[] | null;
  userId?: string | null;
  mine?: boolean;
  permissions: readonly Permission[];
}

/**
 * Lo que completa la bandeja de «Hoy»: avisos que no tenían sitio, la deuda por
 * inquilino, mañana, la semana y lo hecho hoy. Va aparte para que la bandeja
 * principal no tenga que esperar a estas consultas.
 */
@Injectable()
export class TodayExtrasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly collections: CollectionsOpsService,
    private readonly plans: PaymentPlansService,
  ) {}

  async snooze(
    tenantId: string,
    userId: string,
    input: CreateTenantTodaySnoozeInput,
  ): Promise<TenantTodaySnoozeDto> {
    const until = new Date(Date.now() + input.days * DAY);
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.todaySnooze.upsert({
          where: {
            tenantId_kind_refId: { tenantId, kind: input.kind, refId: input.refId },
          },
          create: {
            tenantId,
            kind: input.kind,
            refId: input.refId,
            label: input.label ?? null,
            until,
            createdByUserId: userId,
          },
          update: {
            until,
            createdByUserId: userId,
            ...(input.label ? { label: input.label } : {}),
          },
        }),
      tenantId,
    );
    return this.snoozeDto(row);
  }

  async unsnooze(tenantId: string, id: string): Promise<void> {
    const res = await this.prisma.withTenant(
      (tx) => tx.todaySnooze.deleteMany({ where: { id } }),
      tenantId,
    );
    if (res.count === 0) {
      throw new NotFoundException({ code: 'snooze_not_found', message: 'Aviso no encontrado' });
    }
  }

  private snoozeDto(row: {
    id: string;
    kind: string;
    refId: string;
    label: string | null;
    until: Date;
  }): TenantTodaySnoozeDto {
    return {
      id: row.id,
      kind: row.kind as TenantTodaySnoozeKind,
      refId: row.refId,
      label: row.label,
      until: row.until.toISOString(),
    };
  }

  async extras(tenantId: string, options: TodayExtrasOptions): Promise<TodayExtrasDto> {
    const { facilityId, userId = null, mine = false, permissions } = options;
    const scope = options.facilityScope ?? null;
    const can = (p: Permission) => permissions.includes(p);
    const now = new Date();
    const tenant = await this.prisma.withTenant(
      (tx) => tx.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } }),
      tenantId,
    );
    const timezone = tenant?.timezone ?? 'Europe/Madrid';
    const today = todayInTimezone(timezone, now);
    const tomorrow = new Date(today.getTime() + DAY);
    const weekEnd = new Date(today.getTime() + 8 * DAY);
    const dayStart = zonedDayStart(today.toISOString().slice(0, 10), timezone);

    const ids = resolveFacilityFilter(scope, facilityId);
    const fac = ids === null ? { in: [] as string[] } : ids ? { in: ids } : undefined;
    const facUnit: Prisma.ContractWhereInput = fac ? { unit: { is: { facilityId: fac } } } : {};
    const facOwn = (optionalFacilityWhere(scope, facilityId) ?? {
      facilityId: { in: [] },
    }) as object;
    const invWhere = (invoiceFacilityWhere(scope, facilityId) ?? {
      id: { in: [] },
    }) as Prisma.InvoiceWhereInput;
    const me = mine && userId ? userId : null;

    const data = await this.prisma.withTenant(
      async (tx) => {
        const snoozes = await tx.todaySnooze.findMany({
          where: { until: { gt: now } },
          orderBy: { until: 'asc' },
        });
        const isSnoozed = (kind: TenantTodaySnoozeKind, refId: string) =>
          snoozes.some((s) => s.kind === kind && s.refId === refId);
        const section = (items: TodayAttentionItemDto[]): TodayAttentionSectionDto => {
          const live = items.filter((i) => !isSnoozed(i.kind, i.refId));
          return { count: live.length, items: live.slice(0, TAKE) };
        };
        const none = section([]);
        const week = await this.week(tx, { today, tomorrow, weekEnd, me, facUnit, facOwn, can });
        const done = await this.done(tx, {
          dayStart,
          today,
          me,
          invWhere,
          facilityId: facilityId ?? null,
          facUnit,
          can,
        });
        const snoozed = snoozes.map((s) => this.snoozeDto(s));
        // «Lo mío» es lo asignado a la persona: los avisos generales no entran.
        if (me) {
          return {
            unitRequests: none,
            waitlistMatches: none,
            draftsAttention: none,
            reservationsConfirmed: none,
            paymentProblems: none,
            chatsWaiting: none,
            tomorrow: [] as TodayTomorrowItemDto[],
            week,
            done,
            snoozed,
            isSnoozed,
            section,
          };
        }

        const [unitRequests, waitlist, drafts, reservations, problems, chats, tomorrowItems] =
          await Promise.all([
            can('contracts:read') ? this.unitRequests(tx, facOwn) : [],
            can('reservations:read') ? this.waitlist(tx, fac) : [],
            can('contracts:read') ? this.drafts(tx, tomorrow, now, facUnit) : [],
            can('reservations:read')
              ? this.reservations(tx, now, new Date(now.getTime() + 3 * DAY), facUnit)
              : [],
            can('payments:read') ? this.paymentProblems(tx, dayStart, invWhere) : [],
            can('communications:read') ? this.chats(tx) : [],
            can('contracts:read') ? this.tomorrow(tx, tomorrow, facUnit) : [],
          ]);

        return {
          unitRequests: section(unitRequests),
          waitlistMatches: section(waitlist),
          draftsAttention: section(drafts),
          reservationsConfirmed: section(reservations),
          paymentProblems: section(problems),
          chatsWaiting: section(chats),
          tomorrow: tomorrowItems,
          week,
          done,
          snoozed,
          isSnoozed,
          section,
        };
      },
      tenantId,
      { timeout: TX_TIMEOUT_MS },
    );

    const { isSnoozed, section, ...rest } = data;
    const allowed = can('payments:read') && !me;
    const [plansLate, inventoryIssues, debts] = await Promise.all([
      allowed ? this.plansLate(tenantId, scope, facilityId, today) : [],
      !me && can('units:read') ? this.inventoryItems(tenantId, scope, facilityId) : [],
      allowed
        ? this.debts(tenantId, scope, facilityId, (id) => isSnoozed('customer_debt', id))
        : { count: 0, totalAmount: 0, rows: [] as TodayDebtDto[] },
    ]);
    const lateSection = section(plansLate);
    const inventorySection = section(inventoryIssues);

    return {
      ...rest,
      plansLate: lateSection,
      inventoryIssues: inventorySection,
      debts,
      urgentCount:
        rest.chatsWaiting.count +
        rest.paymentProblems.count +
        rest.draftsAttention.count +
        lateSection.count,
    };
  }

  private async unitRequests(
    tx: Prisma.TransactionClient,
    facOwn: object,
  ): Promise<TodayAttentionItemDto[]> {
    const rows = await tx.unitRequest.findMany({
      where: { status: 'pending', ...facOwn },
      orderBy: { createdAt: 'asc' },
      take: 50,
      include: {
        customer: {
          select: {
            id: true,
            customerType: true,
            firstName: true,
            lastName: true,
            companyName: true,
            phone: true,
          },
        },
        facility: { select: { name: true } },
      },
    });
    return rows.map((r) => ({
      kind: 'unit_request',
      refId: r.id,
      label: personName(r.customer),
      detail: r.facility?.name ?? null,
      date: r.createdAt.toISOString(),
      href: '/unit-requests',
      phone: r.customer.phone,
    }));
  }

  /** Personas en cola con un trastero de su tamaño libre ahora mismo. */
  private async waitlist(
    tx: Prisma.TransactionClient,
    fac: { in: string[] } | undefined,
  ): Promise<TodayAttentionItemDto[]> {
    const facilityFilter = fac ? { facilityId: fac } : {};
    const [entries, free] = await Promise.all([
      tx.waitlistEntry.findMany({
        where: { status: 'waiting', ...facilityFilter },
        orderBy: { createdAt: 'asc' },
        take: 200,
        include: { unitType: { select: { name: true } } },
      }),
      tx.unit.groupBy({
        by: ['facilityId', 'unitTypeId'],
        where: { status: 'available', ...facilityFilter },
        _count: { id: true },
      }),
    ]);
    const freeLeft = new Map<string, number>(
      free.map((f) => [`${f.facilityId}:${f.unitTypeId}`, f._count.id]),
    );
    const items: TodayAttentionItemDto[] = [];
    for (const e of entries) {
      const key = `${e.facilityId}:${e.unitTypeId}`;
      const left = freeLeft.get(key) ?? 0;
      if (left <= 0) continue;
      // Uno por trastero libre, por orden de llegada.
      freeLeft.set(key, left - 1);
      items.push({
        kind: 'waitlist',
        refId: e.id,
        label: e.contactName,
        detail: e.unitType.name,
        date: e.createdAt.toISOString(),
        href: '/waitlist',
        phone: e.contactPhone,
      });
    }
    return items;
  }

  /** Borradores que ya deberían estar firmados: empiezan hoy o su enlace caducó. */
  private async drafts(
    tx: Prisma.TransactionClient,
    tomorrow: Date,
    now: Date,
    facUnit: Prisma.ContractWhereInput,
  ): Promise<TodayAttentionItemDto[]> {
    const rows = await tx.contract.findMany({
      where: {
        status: 'draft',
        deletedAt: null,
        signedAt: null,
        preOpening: false,
        ...facUnit,
        OR: [
          { startDate: { lt: tomorrow } },
          { signingTokenHash: { not: null }, signingTokenExpiresAt: { lt: now } },
        ],
      },
      orderBy: { startDate: 'asc' },
      take: 50,
      include: {
        customer: {
          select: {
            customerType: true,
            firstName: true,
            lastName: true,
            companyName: true,
            phone: true,
          },
        },
        unit: { select: { code: true } },
      },
    });
    return rows.map((c) => {
      const expired = !!c.signingTokenExpiresAt && c.signingTokenExpiresAt < now;
      return {
        kind: 'draft',
        refId: c.id,
        label: personName(c.customer),
        detail: `${c.unit.code} · ${expired ? 'enlace caducado' : 'empieza sin firmar'}`,
        date: c.startDate.toISOString(),
        href: `/contracts/${c.id}?tab=signing`,
        phone: c.customer.phone,
      };
    });
  }

  private async reservations(
    tx: Prisma.TransactionClient,
    now: Date,
    limit: Date,
    facUnit: Prisma.ContractWhereInput,
  ): Promise<TodayAttentionItemDto[]> {
    const rows = await tx.reservation.findMany({
      where: {
        status: 'confirmed',
        validUntil: { gte: now, lte: limit },
        ...(facUnit as Prisma.ReservationWhereInput),
      },
      orderBy: { validUntil: 'asc' },
      take: 50,
      include: {
        customer: {
          select: {
            customerType: true,
            firstName: true,
            lastName: true,
            companyName: true,
            phone: true,
          },
        },
        unit: { select: { code: true } },
      },
    });
    return rows.map((r) => ({
      kind: 'reservation',
      refId: r.id,
      label: r.customer ? personName(r.customer) : 'Reserva',
      detail: r.unit?.code ?? null,
      date: r.validUntil.toISOString(),
      href: '/reservations?status=confirmed',
      phone: r.customer?.phone ?? null,
    }));
  }

  /** Cobros rechazados y recibos devueltos de hoy. */
  private async paymentProblems(
    tx: Prisma.TransactionClient,
    dayStart: Date,
    invWhere: Prisma.InvoiceWhereInput,
  ): Promise<TodayAttentionItemDto[]> {
    const rows = await tx.payment.findMany({
      where: {
        invoice: invWhere,
        status: 'failed',
        OR: [{ returnedAt: { gte: dayStart } }, { returnedAt: null, updatedAt: { gte: dayStart } }],
      },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      include: {
        invoice: {
          select: {
            id: true,
            invoiceNumber: true,
            customer: {
              select: {
                customerType: true,
                firstName: true,
                lastName: true,
                companyName: true,
                phone: true,
              },
            },
          },
        },
      },
    });
    return rows.flatMap((p) => {
      if (!p.invoice) return [];
      return [
        {
          kind: 'payment' as const,
          refId: p.id,
          label: personName(p.invoice.customer),
          detail: `${p.returnedAt ? 'Recibo devuelto' : 'Cobro rechazado'} · ${formatEur(Number(p.amount))}`,
          date: (p.returnedAt ?? p.updatedAt).toISOString(),
          href: `/invoices/${p.invoice.id}`,
          phone: p.invoice.customer?.phone ?? null,
        },
      ];
    });
  }

  /** Conversaciones que esperan a una persona del equipo. */
  private async chats(tx: Prisma.TransactionClient): Promise<TodayAttentionItemDto[]> {
    const [web, whatsapp] = await Promise.all([
      tx.webChatConversation.findMany({
        where: { mode: 'human', staffUnread: { gt: 0 } },
        orderBy: { lastMessageAt: 'asc' },
        take: 25,
      }),
      tx.whatsappConversation.findMany({
        where: { assistantEnabled: false, unreadCount: { gt: 0 } },
        orderBy: { lastMessageAt: 'asc' },
        take: 25,
      }),
    ]);
    return [
      ...web.map(
        (c): TodayAttentionItemDto => ({
          kind: 'chat',
          refId: c.id,
          label: 'Chat de la web',
          detail: c.handoffSummary?.slice(0, 80) ?? null,
          date: c.lastMessageAt.toISOString(),
          href: '/marketing/web-chat',
        }),
      ),
      ...whatsapp.map(
        (c): TodayAttentionItemDto => ({
          kind: 'chat',
          refId: c.id,
          label: c.contactName ?? 'WhatsApp',
          detail: c.lastMessagePreview?.slice(0, 80) ?? null,
          date: c.lastMessageAt.toISOString(),
          href: '/whatsapp',
        }),
      ),
    ];
  }

  private async tomorrow(
    tx: Prisma.TransactionClient,
    tomorrow: Date,
    facUnit: Prisma.ContractWhereInput,
  ): Promise<TodayTomorrowItemDto[]> {
    const customer = {
      select: {
        customerType: true,
        firstName: true,
        lastName: true,
        companyName: true,
        phone: true,
        credentials: { where: { status: 'active' }, select: { id: true }, take: 1 },
      },
    } as const;
    const [entering, leaving, devices] = await Promise.all([
      tx.contract.findMany({
        where: {
          status: { in: ['draft', 'active', 'ending'] },
          deletedAt: null,
          startDate: tomorrow,
          preOpening: false,
          ...facUnit,
        },
        take: 50,
        include: {
          customer,
          unit: { select: { code: true } },
          invoices: {
            where: { deletedAt: null, status: { in: ['issued', 'overdue'] } },
            select: { kind: true },
          },
        },
      }),
      tx.contract.findMany({
        where: {
          status: { in: ['active', 'ending'] },
          deletedAt: null,
          endDate: tomorrow,
          OR: [{ status: 'ending' }, { autoRenew: false }],
          ...facUnit,
        },
        take: 50,
        include: { customer, unit: { select: { code: true } } },
      }),
      tx.accessDevice.count(),
    ]);
    const photos = leaving.length
      ? await tx.contractInspectionPhoto.groupBy({
          by: ['contractId'],
          where: { contractId: { in: leaving.map((c) => c.id) }, kind: 'checkout' },
        })
      : [];
    const withPhotos = new Set(photos.map((p) => p.contractId));
    return [
      ...entering.map((c): TodayTomorrowItemDto => {
        const missing: string[] = [];
        if (c.status === 'draft') missing.push('Firma');
        if (c.invoices.some((i) => i.kind === 'invoice')) missing.push('Primer pago');
        if (c.invoices.some((i) => i.kind === 'deposit_receipt')) missing.push('Fianza');
        if (devices > 0 && c.customer.credentials.length === 0) missing.push('Acceso');
        return {
          id: c.id,
          kind: 'in',
          label: personName(c.customer),
          detail: c.unit.code,
          phone: c.customer.phone,
          missing,
        };
      }),
      ...leaving.map((c): TodayTomorrowItemDto => {
        const missing: string[] = [];
        if (!withPhotos.has(c.id)) missing.push('Fotos de salida');
        if (c.depositStatus === 'held') missing.push('Liquidar la fianza');
        return {
          id: c.id,
          kind: 'out',
          label: personName(c.customer),
          detail: c.unit.code,
          phone: c.customer.phone,
          missing,
        };
      }),
    ];
  }

  private async week(
    tx: Prisma.TransactionClient,
    args: {
      today: Date;
      tomorrow: Date;
      weekEnd: Date;
      me: string | null;
      facUnit: Prisma.ContractWhereInput;
      facOwn: object;
      can: (p: Permission) => boolean;
    },
  ): Promise<TodayWeekItemDto[]> {
    const { tomorrow, weekEnd, me, facUnit, facOwn, can } = args;
    const range = { gte: tomorrow, lt: weekEnd };
    const [tasks, followups, leadFollowups, moveIns, moveOuts, reminders] = await Promise.all([
      can('tasks:read')
        ? tx.task.findMany({
            where: {
              status: { in: ['open', 'in_progress'] },
              deletedAt: null,
              dueDate: range,
              ...(me ? { assignedToUserId: me } : {}),
              ...facOwn,
            },
            take: TAKE_WEEK,
            select: { id: true, title: true, dueDate: true },
          })
        : [],
      can('customers:read')
        ? tx.customerFollowup.findMany({
            where: {
              status: 'pending',
              dueDate: range,
              ...(me ? { createdByUserId: me } : {}),
            },
            take: TAKE_WEEK,
            include: {
              customer: {
                select: { customerType: true, firstName: true, lastName: true, companyName: true },
              },
            },
          })
        : [],
      can('leads:read')
        ? tx.leadFollowup.findMany({
            where: {
              status: 'pending',
              dueDate: range,
              lead: { deletedAt: null, ...(me ? { assignedToUserId: me } : {}) },
            },
            take: TAKE_WEEK,
            include: { lead: { select: { firstName: true, lastName: true, companyName: true } } },
          })
        : [],
      me
        ? []
        : tx.contract.findMany({
            where: {
              status: { in: ['active', 'ending'] },
              deletedAt: null,
              startDate: range,
              preOpening: false,
              ...facUnit,
            },
            take: TAKE_WEEK,
            include: {
              customer: {
                select: { customerType: true, firstName: true, lastName: true, companyName: true },
              },
              unit: { select: { code: true } },
            },
          }),
      me
        ? []
        : tx.contract.findMany({
            where: {
              status: { in: ['active', 'ending'] },
              deletedAt: null,
              endDate: range,
              OR: [{ status: 'ending' }, { autoRenew: false }],
              ...facUnit,
            },
            take: TAKE_WEEK,
            include: {
              customer: {
                select: { customerType: true, firstName: true, lastName: true, companyName: true },
              },
              unit: { select: { code: true } },
            },
          }),
      !me && can('reminders:read')
        ? tx.businessReminder.findMany({
            where: { status: 'active', dueDate: range },
            take: TAKE_WEEK,
            select: { id: true, title: true, dueDate: true },
          })
        : [],
    ]);
    const items: TodayWeekItemDto[] = [
      ...tasks.map(
        (t): TodayWeekItemDto => ({
          id: t.id,
          kind: 'task',
          label: t.title,
          detail: null,
          date: t.dueDate!.toISOString(),
          href: `/tasks?task=${t.id}`,
        }),
      ),
      ...followups.map(
        (f): TodayWeekItemDto => ({
          id: f.id,
          kind: 'followup',
          label: f.title,
          detail: personName(f.customer),
          date: f.dueDate.toISOString(),
          href: `/customers/${f.customerId}`,
        }),
      ),
      ...leadFollowups.map(
        (f): TodayWeekItemDto => ({
          id: f.id,
          kind: 'lead_followup',
          label: f.title,
          detail: personName(f.lead),
          date: f.dueDate.toISOString(),
          href: `/leads?lead=${f.leadId}`,
        }),
      ),
      ...moveIns.map(
        (c): TodayWeekItemDto => ({
          id: c.id,
          kind: 'move_in',
          label: personName(c.customer),
          detail: c.unit.code,
          date: c.startDate.toISOString(),
          href: `/contracts/${c.id}`,
        }),
      ),
      ...moveOuts.map(
        (c): TodayWeekItemDto => ({
          id: c.id,
          kind: 'move_out',
          label: personName(c.customer),
          detail: c.unit.code,
          date: c.endDate!.toISOString(),
          href: `/contracts/${c.id}`,
        }),
      ),
      ...reminders.map(
        (r): TodayWeekItemDto => ({
          id: r.id,
          kind: 'reminder',
          label: r.title,
          detail: null,
          date: r.dueDate.toISOString(),
          href: `/reminders?reminder=${r.id}`,
        }),
      ),
    ];
    return items.sort((a, b) => a.date.localeCompare(b.date)).slice(0, TAKE_WEEK);
  }

  private async done(
    tx: Prisma.TransactionClient,
    args: {
      dayStart: Date;
      today: Date;
      me: string | null;
      invWhere: Prisma.InvoiceWhereInput;
      facilityId: string | null;
      facUnit: Prisma.ContractWhereInput;
      can: (p: Permission) => boolean;
    },
  ): Promise<TodayDoneDto> {
    const { dayStart, today, me, invWhere, facilityId, facUnit, can } = args;
    const since = { gte: dayStart };
    const money = can('payments:read') && !me;
    const [tasks, followups, leadFollowups, signed, contacted, payments, closure] =
      await Promise.all([
        tx.task.count({
          where: {
            status: 'done',
            deletedAt: null,
            completedAt: since,
            ...(me ? { assignedToUserId: me } : {}),
          },
        }),
        tx.customerFollowup.count({
          where: {
            status: 'done',
            completedAt: since,
            ...(me ? { createdByUserId: me } : {}),
          },
        }),
        tx.leadFollowup.count({ where: { status: 'done', completedAt: since } }),
        me ? 0 : tx.contract.count({ where: { signedAt: since, deletedAt: null, ...facUnit } }),
        tx.lead.count({
          where: {
            contactedAt: since,
            deletedAt: null,
            ...(me ? { assignedToUserId: me } : {}),
          },
        }),
        money
          ? tx.payment.groupBy({
              by: ['methodType'],
              where: {
                invoice: invWhere,
                status: { in: ['succeeded', 'partially_refunded', 'refunded'] },
                paidAt: since,
                methodType: { notIn: [...NON_CASH_PAYMENT_METHODS] },
              },
              _sum: { amount: true },
              _count: { _all: true },
            })
          : [],
        money
          ? tx.cashClosure.findFirst({
              where: { closureDate: today, facilityId },
              select: { id: true },
            })
          : null,
      ]);
    const rows = payments.map((p) => ({
      method: p.methodType ?? 'other',
      label: METHOD_LABELS[p.methodType ?? 'other'] ?? 'Otros',
      amount: Math.round(Number(p._sum.amount ?? 0) * 100) / 100,
      count: p._count._all,
    }));
    return {
      tasks,
      followups: followups + leadFollowups,
      contractsSigned: signed,
      leadsContacted: contacted,
      payments: rows,
      collected: Math.round(rows.reduce((n, r) => n + r.amount, 0) * 100) / 100,
      cashClosed: !!closure,
    };
  }

  private async plansLate(
    tenantId: string,
    scope: string[] | null,
    facilityId: string | undefined,
    today: Date,
  ): Promise<TodayAttentionItemDto[]> {
    const plans = await this.plans.list(tenantId, { status: 'active' });
    const late = plans.filter((p) => p.installments.some((i) => i.status === 'late'));
    if (late.length === 0) return [];
    const invWhere = invoiceFacilityWhere(scope, facilityId);
    if (!invWhere) return [];
    const visible = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findMany({
          where: {
            AND: [{ id: { in: late.flatMap((p) => p.invoiceIds) } }, invWhere],
          },
          select: { id: true },
        }),
      tenantId,
    );
    const ids = new Set(visible.map((v) => v.id));
    const day = today.toISOString().slice(0, 10);
    return late
      .filter((p) => p.invoiceIds.some((id) => ids.has(id)))
      .map((p) => {
        const due = p.installments.find((i) => i.status === 'late')!;
        return {
          kind: 'plan',
          refId: p.id,
          label: p.customerName,
          detail: `Cuota de ${formatEur(due.amount - due.paid)} sin pagar`,
          date: due.dueDate <= day ? due.dueDate : null,
          href: `/customers/${p.customerId}`,
        };
      });
  }

  private async inventoryItems(
    tenantId: string,
    scope: string[] | null,
    facilityId: string | undefined,
  ): Promise<TodayAttentionItemDto[]> {
    const issues = await this.inventory.findIssues(tenantId, scope);
    return issues
      .filter((i) => !facilityId || i.facilityId === facilityId)
      .map((i) => ({
        kind: 'inventory',
        refId: i.unitId,
        label: `Trastero ${i.code}`,
        detail: i.reason,
        date: null,
        href: `/units/${i.unitId}`,
      }));
  }

  private async debts(
    tenantId: string,
    scope: string[] | null,
    facilityId: string | undefined,
    isSnoozed: (customerId: string) => boolean,
  ): Promise<TodayExtrasDto['debts']> {
    const arrears = await this.collections.arrears(tenantId, scope, facilityId);
    const rows = arrears.rows
      .filter((r) => !isSnoozed(r.customerId))
      .sort((a, b) => b.amount - a.amount);
    const top = rows.slice(0, TAKE_DEBTS);
    const contacts = await this.prisma.withTenant(async (tx) => {
      const customerId = { in: top.map((r) => r.customerId) };
      const [sent, notes] = await Promise.all([
        tx.communication.groupBy({
          by: ['customerId'],
          where: { customerId, sentAt: { not: null } },
          _max: { sentAt: true },
        }),
        tx.customerInteraction.groupBy({
          by: ['customerId'],
          where: { customerId },
          _max: { occurredAt: true },
        }),
      ]);
      const last = new Map<string, Date>();
      const note = (id: string | null, at: Date | null) => {
        if (!id || !at) return;
        const known = last.get(id);
        if (!known || at > known) last.set(id, at);
      };
      sent.forEach((s) => note(s.customerId, s._max.sentAt));
      notes.forEach((s) => note(s.customerId, s._max.occurredAt));
      return last;
    }, tenantId);
    return {
      count: rows.length,
      totalAmount: Math.round(rows.reduce((n, r) => n + r.amount, 0) * 100) / 100,
      rows: top.map((r) => ({
        customerId: r.customerId,
        customerName: r.customerName,
        phone: r.phone,
        amount: r.amount,
        days: r.days,
        invoiceCount: r.invoiceCount,
        invoiceIds: r.invoiceIds,
        chargeable: r.chargeable && !r.plan,
        note: r.plan ? 'En plan de pagos' : r.sepaMandate ? 'Va en la remesa' : null,
        nextStep: r.nextStep,
        lastContactAt: contacts.get(r.customerId)?.toISOString() ?? null,
      })),
    };
  }
}
