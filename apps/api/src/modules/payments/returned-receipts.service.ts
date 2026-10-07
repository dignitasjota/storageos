import { BadRequestException, Injectable } from '@nestjs/common';

import { subtractAmounts } from '../../common/money';
import { PrismaService } from '../database/prisma.service';

import type { Prisma } from '@storageos/database';
import type {
  ReturnedReceiptDto,
  ReturnedReceiptKind,
  ReturnedReceiptsDto,
} from '@storageos/shared';

const DAY = 86_400_000;
const PENDING_STATUSES = new Set(['issued', 'overdue']);

interface InvoiceRef {
  id: string;
  invoiceNumber: string;
  status: string;
  total: Prisma.Decimal;
  amountPaid: Prisma.Decimal;
  customer: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
  } | null;
  facility: { name: string } | null;
  contract: { unit: { facility: { name: string } } } | null;
}

const INVOICE_SELECT = {
  id: true,
  invoiceNumber: true,
  status: true,
  total: true,
  amountPaid: true,
  customer: { select: { id: true, firstName: true, lastName: true, companyName: true } },
  facility: { select: { name: true } },
  contract: { select: { unit: { select: { facility: { select: { name: true } } } } } },
} as const;

/** «Contracargo», «Fallo tardío»… a partir del motivo guardado en el cobro. */
export function returnReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  const disputed = /^disputed:\s*(.*)$/i.exec(reason);
  if (!disputed) return reason;
  const code = disputed[1]?.trim() ?? '';
  if (code === 'late_failure') return 'El banco devolvió el adeudo tras cobrarlo';
  if (!code || code === 'unknown') return 'Contracargo o devolución';
  return `Contracargo o devolución (${code.replace(/_/g, ' ')})`;
}

function returnKind(row: {
  methodType: string;
  gateway: string;
  failureReason: string | null;
}): ReturnedReceiptKind {
  if (row.methodType === 'sepa_debit' || row.gateway === 'gocardless') return 'direct_debit_return';
  if (row.gateway === 'stripe') return 'chargeback';
  return 'bank_return';
}

function customerName(c: InvoiceRef['customer']): string | null {
  if (!c) return null;
  return c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ') || null;
}

function invoiceFields(inv: InvoiceRef | null) {
  if (!inv) {
    return {
      invoiceId: null,
      invoiceNumber: null,
      invoiceStatus: null,
      invoicePending: 0,
      customerId: null,
      customerName: null,
      facilityName: null,
    };
  }
  const pending = PENDING_STATUSES.has(inv.status)
    ? Math.max(0, subtractAmounts(inv.total, inv.amountPaid))
    : 0;
  return {
    invoiceId: inv.id,
    invoiceNumber: inv.invoiceNumber,
    invoiceStatus: inv.status,
    invoicePending: pending,
    customerId: inv.customer?.id ?? null,
    customerName: customerName(inv.customer),
    facilityName: inv.contract?.unit.facility.name ?? inv.facility?.name ?? null,
  };
}

/**
 * Listado de recibos devueltos: cobros que ya estaban cobrados y se
 * devolvieron (devolución bancaria registrada a mano o desde la conciliación
 * N43, contracargos de tarjeta, devoluciones y fallos tardíos de GoCardless) y
 * adeudos que el banco rechazó al confirmar una remesa SEPA.
 */
@Injectable()
export class ReturnedReceiptsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    tenantId: string,
    filters: {
      from?: string;
      to?: string;
      kind?: string;
      facilityId?: string;
      facilityScope?: string[] | null;
    },
  ): Promise<ReturnedReceiptsDto> {
    const now = new Date();
    const to = filters.to ? new Date(`${filters.to}T23:59:59.999Z`) : now;
    const from = filters.from
      ? new Date(`${filters.from}T00:00:00.000Z`)
      : new Date(to.getTime() - 90 * DAY);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException({ code: 'invalid_date', message: 'Fecha no válida' });
    }

    // Local: el de la factura (vía contrato o el suyo propio).
    const facilityFilter: Prisma.InvoiceWhereInput | undefined = filters.facilityId
      ? {
          OR: [
            { contract: { unit: { facilityId: filters.facilityId } } },
            { facilityId: filters.facilityId },
          ],
        }
      : undefined;
    const scopeFilter: Prisma.InvoiceWhereInput | undefined = filters.facilityScope
      ? {
          OR: [
            { contract: { unit: { facilityId: { in: filters.facilityScope } } } },
            { facilityId: { in: filters.facilityScope } },
            { contractId: null, facilityId: null },
          ],
        }
      : undefined;
    const invoiceWhere: Prisma.InvoiceWhereInput | undefined =
      facilityFilter || scopeFilter
        ? { AND: [facilityFilter, scopeFilter].filter((w): w is Prisma.InvoiceWhereInput => !!w) }
        : undefined;

    const [payments, rejected] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.payment.findMany({
            where: {
              returnedAt: { gte: from, lte: to },
              ...(invoiceWhere ? { invoice: invoiceWhere } : {}),
            },
            orderBy: { returnedAt: 'desc' },
            take: 2000,
            select: {
              id: true,
              amount: true,
              methodType: true,
              gateway: true,
              failureReason: true,
              returnedAt: true,
              invoice: { select: INVOICE_SELECT },
            },
          }),
          tx.sepaRemittanceItem.findMany({
            where: {
              status: 'failed',
              remittance: { confirmedAt: { gte: from, lte: to } },
              ...(invoiceWhere ? { invoice: invoiceWhere } : {}),
            },
            take: 2000,
            select: {
              id: true,
              amount: true,
              failureReason: true,
              remittance: { select: { name: true, confirmedAt: true } },
              invoice: { select: INVOICE_SELECT },
            },
          }),
        ]),
      tenantId,
    );

    let items: ReturnedReceiptDto[] = [
      ...payments.map((p) => ({
        id: p.id,
        kind: returnKind(p),
        date: (p.returnedAt ?? now).toISOString(),
        amount: Number(p.amount),
        reason: returnReasonLabel(p.failureReason),
        remittanceName: null,
        ...invoiceFields(p.invoice as InvoiceRef | null),
      })),
      ...rejected.map((r) => ({
        id: r.id,
        kind: 'sepa_rejected' as const,
        date: (r.remittance.confirmedAt ?? now).toISOString(),
        amount: r.amount / 100,
        reason: r.failureReason ?? 'Rechazado por el banco',
        remittanceName: r.remittance.name,
        ...invoiceFields(r.invoice as InvoiceRef),
      })),
    ];
    if (filters.kind) items = items.filter((i) => i.kind === filters.kind);
    items.sort((a, b) => b.date.localeCompare(a.date));

    const byKind = new Map<ReturnedReceiptKind, { count: number; cents: number }>();
    let cents = 0;
    // Lo pendiente se cuenta una vez por factura aunque tenga varias devoluciones.
    const pendingByInvoice = new Map<string, number>();
    for (const i of items) {
      const c = Math.round(i.amount * 100);
      cents += c;
      const k = byKind.get(i.kind) ?? { count: 0, cents: 0 };
      k.count += 1;
      k.cents += c;
      byKind.set(i.kind, k);
      if (i.invoiceId) pendingByInvoice.set(i.invoiceId, Math.round(i.invoicePending * 100));
    }
    const pendingCents = [...pendingByInvoice.values()].reduce((a, b) => a + b, 0);

    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      items,
      totals: {
        count: items.length,
        amount: cents / 100,
        stillPending: pendingCents / 100,
        byKind: [...byKind.entries()].map(([kind, v]) => ({
          kind,
          count: v.count,
          amount: v.cents / 100,
        })),
      },
    };
  }
}
