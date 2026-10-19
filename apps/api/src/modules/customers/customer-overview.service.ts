import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';

import type { CustomerAccountDto, CustomerOverviewDto, CustomerPayVia } from '@storageos/shared';

const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const LIVE = ['active', 'ending'] as const;

const STEP_LABEL: Record<string, string> = {
  email_reminder: 'Primer recordatorio',
  email_reminder_final: 'Segundo recordatorio',
  sms_reminder: 'Recordatorio por SMS',
  late_fee: 'Recargo por mora',
  access_block: 'Corte de acceso',
  legal_notice: 'Aviso legal',
};

/** Cuota mensual de un contrato: alquiler − descuento + seguro (sin IVA). */
function contractMonthly(c: {
  priceMonthly: unknown;
  discountAmount: unknown;
  insurancePrice: unknown;
}): number {
  return round2(
    Math.max(0, Number(c.priceMonthly) - Number(c.discountAmount)) + Number(c.insurancePrice ?? 0),
  );
}

/**
 * Visión de los inquilinos del operador: una fila por inquilino con lo que
 * paga, cómo, si debe algo, qué extras tiene y cuándo se habló con él por
 * última vez; y el estado de cuenta de la ficha. Todo con RLS del tenant.
 */
@Injectable()
export class CustomerOverviewService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(tenantId: string): Promise<CustomerOverviewDto[]> {
    return this.prisma.withTenant(async (tx) => {
      const [
        customers,
        contracts,
        methods,
        mandates,
        overdue,
        notDue,
        comms,
        interactions,
        messages,
        followups,
      ] = await Promise.all([
        tx.customer.findMany({
          where: { deletedAt: null },
          select: {
            id: true,
            customerType: true,
            firstName: true,
            lastName: true,
            companyName: true,
            email: true,
            phone: true,
            tags: true,
            kycVerified: true,
            portalAccessEnabled: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 10_000,
        }),
        tx.contract.findMany({
          where: { deletedAt: null, status: { in: [...LIVE] } },
          select: {
            customerId: true,
            status: true,
            endDate: true,
            priceMonthly: true,
            discountAmount: true,
            insurancePrice: true,
            insurancePlan: { select: { name: true } },
            unit: {
              select: { code: true, facilityId: true, facility: { select: { name: true } } },
            },
          },
        }),
        tx.paymentMethod.findMany({
          where: { deletedAt: null, type: { in: ['card', 'sepa_debit'] } },
          select: { customerId: true, type: true, isDefault: true },
        }),
        tx.sepaMandate.findMany({
          where: { status: 'active' },
          select: { customerId: true },
        }),
        tx.invoice.groupBy({
          by: ['customerId'],
          where: { deletedAt: null, kind: 'invoice', status: 'overdue', customerId: { not: null } },
          _sum: { total: true, amountPaid: true },
          _min: { dueDate: true },
        }),
        tx.invoice.groupBy({
          by: ['customerId'],
          where: { deletedAt: null, kind: 'invoice', status: 'issued', customerId: { not: null } },
          _sum: { total: true, amountPaid: true },
        }),
        tx.communication.groupBy({
          by: ['customerId'],
          where: { customerId: { not: null }, sentAt: { not: null } },
          _max: { sentAt: true },
        }),
        tx.customerInteraction.groupBy({ by: ['customerId'], _max: { occurredAt: true } }),
        tx.customerMessage.groupBy({ by: ['customerId'], _max: { createdAt: true } }),
        tx.customerFollowup.findMany({
          where: { status: 'pending' },
          select: { customerId: true, title: true, dueDate: true },
          orderBy: { dueDate: 'asc' },
        }),
      ]);

      const byCustomer = <T extends { customerId: string | null }>(rows: T[]) => {
        const m = new Map<string, T[]>();
        for (const r of rows) {
          if (!r.customerId) continue;
          m.set(r.customerId, [...(m.get(r.customerId) ?? []), r]);
        }
        return m;
      };
      const contractsBy = byCustomer(contracts);
      const methodsBy = byCustomer(methods);
      const mandateSet = new Set(mandates.map((m) => m.customerId));
      const overdueBy = new Map(overdue.map((o) => [o.customerId!, o]));
      const notDueBy = new Map(notDue.map((o) => [o.customerId!, o]));
      const lastBy = new Map<string, Date>();
      const bump = (id: string | null, d: Date | null | undefined) => {
        if (!id || !d) return;
        const prev = lastBy.get(id);
        if (!prev || d > prev) lastBy.set(id, d);
      };
      for (const c of comms) bump(c.customerId, c._max.sentAt);
      for (const i of interactions) bump(i.customerId, i._max.occurredAt);
      for (const m of messages) bump(m.customerId, m._max.createdAt);
      const followupBy = new Map<string, { title: string; dueDate: Date }>();
      for (const f of followups) if (!followupBy.has(f.customerId)) followupBy.set(f.customerId, f);

      return customers.map((c) => {
        const live = contractsBy.get(c.id) ?? [];
        const ms = methodsBy.get(c.id) ?? [];
        const preferred = ms.find((m) => m.isDefault) ?? ms[0];
        const payVia: CustomerPayVia = preferred
          ? (preferred.type as 'card' | 'sepa_debit')
          : mandateSet.has(c.id)
            ? 'sepa_mandate'
            : null;
        const od = overdueBy.get(c.id);
        const nd = notDueBy.get(c.id);
        const ends = live.map((l) => l.endDate).filter((d): d is Date => !!d);
        const f = followupBy.get(c.id);
        const displayName =
          c.customerType === 'business'
            ? (c.companyName ?? '—')
            : [c.firstName, c.lastName].filter(Boolean).join(' ') || '—';
        return {
          id: c.id,
          displayName,
          customerType: c.customerType as 'individual' | 'business',
          email: c.email,
          phone: c.phone,
          tags: c.tags,
          kycVerified: c.kycVerified,
          portalAccessEnabled: c.portalAccessEnabled,
          createdAt: c.createdAt.toISOString(),
          units: live.map((l) => ({ code: l.unit.code, facilityName: l.unit.facility.name })),
          facilityIds: [...new Set(live.map((l) => l.unit.facilityId))],
          monthly: round2(live.reduce((s, l) => s + contractMonthly(l), 0)),
          contractStatus:
            live.length === 0
              ? 'none'
              : live.some((l) => l.status === 'active')
                ? 'active'
                : 'ending',
          endsOn: ends.length
            ? new Date(Math.min(...ends.map((d) => d.getTime()))).toISOString().slice(0, 10)
            : null,
          payVia,
          insurance: [
            ...new Set(live.map((l) => l.insurancePlan?.name).filter((n): n is string => !!n)),
          ],
          overdue: od
            ? round2(Math.max(0, Number(od._sum.total ?? 0) - Number(od._sum.amountPaid ?? 0)))
            : 0,
          overdueSince: od?._min.dueDate ? od._min.dueDate.toISOString().slice(0, 10) : null,
          pendingNotDue: nd
            ? round2(Math.max(0, Number(nd._sum.total ?? 0) - Number(nd._sum.amountPaid ?? 0)))
            : 0,
          lastContactAt: lastBy.get(c.id)?.toISOString() ?? null,
          nextFollowup: f
            ? { title: f.title, dueDate: f.dueDate.toISOString().slice(0, 10) }
            : null,
        };
      });
    }, tenantId);
  }

  async account(
    tenantId: string,
    customerId: string,
    now = new Date(),
  ): Promise<CustomerAccountDto> {
    return this.prisma.withTenant(async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: customerId, deletedAt: null },
        select: { id: true },
      });
      if (!customer) {
        throw new NotFoundException({
          code: 'customer_not_found',
          message: 'Inquilino no encontrado',
        });
      }
      const [tenant, contracts, methods, mandate, overdue, notDue, paid, nightPasses] =
        await Promise.all([
          tx.tenant.findUnique({ where: { id: tenantId }, select: { autoChargeOnIssue: true } }),
          tx.contract.findMany({
            where: { customerId, deletedAt: null, status: { in: [...LIVE] } },
            select: {
              id: true,
              contractNumber: true,
              status: true,
              endDate: true,
              priceMonthly: true,
              discountAmount: true,
              insurancePrice: true,
              billingIntervalMonths: true,
              depositAmount: true,
              depositStatus: true,
              insurancePlan: { select: { name: true } },
              unit: { select: { code: true, facility: { select: { name: true } } } },
              invoices: {
                where: { deletedAt: null, kind: 'invoice', periodEnd: { not: null } },
                select: { periodEnd: true },
                orderBy: { periodEnd: 'desc' },
                take: 1,
              },
            },
            orderBy: { createdAt: 'asc' },
          }),
          tx.paymentMethod.findMany({
            where: { customerId, deletedAt: null, type: { in: ['card', 'sepa_debit'] } },
            select: { type: true, isDefault: true, last4: true, brand: true },
          }),
          tx.sepaMandate.findFirst({
            where: { customerId, status: 'active' },
            select: { ibanLast4: true },
          }),
          tx.invoice.findMany({
            where: { customerId, deletedAt: null, kind: 'invoice', status: 'overdue' },
            select: { id: true, invoiceNumber: true, dueDate: true, total: true, amountPaid: true },
            orderBy: { dueDate: 'asc' },
          }),
          tx.invoice.aggregate({
            where: { customerId, deletedAt: null, kind: 'invoice', status: 'issued' },
            _sum: { total: true, amountPaid: true },
          }),
          tx.payment.aggregate({
            where: {
              customerId,
              status: { in: ['succeeded', 'partially_refunded'] },
              paidAt: { gte: new Date(now.getTime() - 365 * DAY) },
              methodType: { notIn: ['credit_note', 'withholding'] },
            },
            _sum: { amount: true, refundedAmount: true },
          }),
          tx.accessCredential.count({
            where: {
              customerId,
              createdAt: { gte: new Date(now.getTime() - 30 * DAY) },
              metadata: { path: ['source'], equals: 'night_pass' },
            },
          }),
        ]);

      const lines = contracts.map((c) => {
        const rent = Number(c.priceMonthly);
        const discount = Number(c.discountAmount);
        const insurance = Number(c.insurancePrice ?? 0);
        return {
          contractId: c.id,
          contractNumber: c.contractNumber,
          status: c.status,
          unitCode: c.unit.code,
          facilityName: c.unit.facility.name,
          rent,
          discount,
          insurance,
          insuranceName: c.insurancePlan?.name ?? null,
          total: contractMonthly(c),
          billingIntervalMonths: c.billingIntervalMonths,
          endDate: c.endDate?.toISOString().slice(0, 10) ?? null,
          depositAmount: Number(c.depositAmount),
          depositStatus: c.depositStatus,
        };
      });
      const monthly = round2(lines.reduce((s, l) => s + l.total, 0));

      const pm = methods.find((m) => m.isDefault) ?? methods[0];
      const payVia: CustomerPayVia = pm
        ? (pm.type as 'card' | 'sepa_debit')
        : mandate
          ? 'sepa_mandate'
          : null;
      const payViaLabel = pm
        ? pm.type === 'card'
          ? `${pm.brand ? pm.brand.charAt(0).toUpperCase() + pm.brand.slice(1) : 'Tarjeta'}${pm.last4 ? ` ··${pm.last4}` : ''}`
          : `Adeudo${pm.last4 ? ` ··${pm.last4}` : ''}`
        : mandate
          ? `Remesa SEPA ··${mandate.ibanLast4}`
          : null;

      // Próxima factura: mensual → día 1 del mes siguiente; prepagado → día
      // siguiente al fin del último periodo facturado.
      let nextCharge: CustomerAccountDto['nextCharge'] = null;
      const charges = contracts
        .filter((c) => c.status === 'active')
        .map((c) => {
          const total = contractMonthly(c) * c.billingIntervalMonths;
          if (c.billingIntervalMonths > 1 && c.invoices[0]?.periodEnd) {
            return { date: new Date(c.invoices[0].periodEnd.getTime() + DAY), amount: total };
          }
          return {
            date: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
            amount: total,
          };
        })
        .sort((a, b) => a.date.getTime() - b.date.getTime());
      if (charges.length) {
        const first = charges[0]!.date;
        const sameDay = charges.filter((c) => c.date.getTime() === first.getTime());
        nextCharge = {
          date: first.toISOString().slice(0, 10),
          amount: round2(sameDay.reduce((s, c) => s + c.amount, 0)),
        };
      }

      let overdueDto: CustomerAccountDto['overdue'] = null;
      if (overdue.length) {
        const oldest = overdue[0]!;
        const steps = await tx.dunningAction.findMany({
          where: { invoiceId: oldest.id },
          select: { actionType: true, scheduledFor: true, executedAt: true, status: true },
          orderBy: { scheduledFor: 'asc' },
        });
        const since = oldest.dueDate ?? now;
        overdueDto = {
          amount: round2(
            overdue.reduce((s, i) => s + Math.max(0, Number(i.total) - Number(i.amountPaid)), 0),
          ),
          since: since.toISOString().slice(0, 10),
          days: Math.max(0, Math.floor((now.getTime() - since.getTime()) / DAY)),
          invoices: overdue.map((i) => ({
            id: i.id,
            number: i.invoiceNumber,
            dueDate: (i.dueDate ?? now).toISOString().slice(0, 10),
            pending: round2(Math.max(0, Number(i.total) - Number(i.amountPaid))),
          })),
          steps: steps.map((s) => ({
            type: s.actionType,
            label: STEP_LABEL[s.actionType] ?? s.actionType,
            scheduledFor: s.scheduledFor.toISOString(),
            executedAt: s.executedAt?.toISOString() ?? null,
            status: s.status,
          })),
        };
      }

      return {
        monthly,
        lines,
        payVia,
        payViaLabel,
        autoCharge: !!tenant?.autoChargeOnIssue && !!pm,
        nextCharge,
        overdue: overdueDto,
        pendingNotDue: round2(
          Math.max(0, Number(notDue._sum.total ?? 0) - Number(notDue._sum.amountPaid ?? 0)),
        ),
        paid12m: round2(Number(paid._sum.amount ?? 0) - Number(paid._sum.refundedAmount ?? 0)),
        nightPasses30d: nightPasses,
      };
    }, tenantId);
  }
}
