import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { todayInTimezone } from '../../common/format';
import { isUniqueViolation } from '../../common/prisma-errors';
import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import { FiscalService, quarterRange } from './fiscal.service';

import type {
  FiscalCheckDto,
  FiscalChecksDto,
  FiscalClosureDto,
  FiscalClosureSnapshot,
} from '@storageos/shared';

interface RequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Estados que cuentan en los libros (como en `FiscalService`). */
const FISCAL_STATUSES = [
  'issued',
  'paid',
  'overdue',
  'refunded',
  'partially_refunded',
  'rectified',
] as const;

/** Ejemplos que se enseñan de cada aviso. */
const MAX_ITEMS = 20;

const eur = (n: number): string =>
  `${n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

const day = (d: Date): string =>
  `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;

/** Huecos de una lista ordenada de números («12», «15-17»). */
export function numberingGaps(sorted: number[]): string[] {
  const gaps: string[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur - prev > 1) gaps.push(cur - prev === 2 ? `${prev + 1}` : `${prev + 1}-${cur - 1}`);
  }
  return gaps;
}

/**
 * «Antes de presentar»: lo que conviene revisar en un trimestre, y su cierre
 * (foto de las cifras y bloqueo de cambios de ese periodo).
 */
@Injectable()
export class FiscalPeriodsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fiscal: FiscalService,
    private readonly audit: AuditService,
  ) {}

  async checks(tenantId: string, year: number, quarter: number): Promise<FiscalChecksDto> {
    const { from, to } = quarterRange(year, quarter);
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const data = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } }),
          // Facturas completas del trimestre (para el NIF).
          tx.invoice.findMany({
            where: {
              deletedAt: null,
              kind: 'invoice',
              invoiceType: 'F1',
              status: { in: [...FISCAL_STATUSES] },
              issueDate: { gte: from, lte: to },
            },
            select: {
              id: true,
              invoiceNumber: true,
              customerNameSnapshot: true,
              customerTaxIdSnapshot: true,
              customer: { select: { documentNumber: true } },
            },
            orderBy: { issueDate: 'asc' },
          }),
          // Numeración del año hasta el final del trimestre.
          tx.invoice.findMany({
            where: {
              kind: 'invoice',
              sequenceNumber: { gt: 0 },
              issueDate: { gte: yearStart, lte: to },
            },
            select: {
              sequenceNumber: true,
              seriesId: true,
              series: { select: { prefix: true, name: true } },
            },
          }),
          tx.invoice.findMany({
            where: {
              deletedAt: null,
              status: 'draft',
              OR: [
                { periodStart: { gte: from, lte: to } },
                {
                  periodStart: null,
                  createdAt: { gte: from, lt: new Date(to.getTime() + 86_400_000) },
                },
              ],
            },
            select: { id: true, invoiceNumber: true, total: true },
            orderBy: { createdAt: 'asc' },
          }),
          tx.invoice.findMany({
            where: {
              deletedAt: null,
              kind: 'invoice',
              issueDate: { gte: from, lte: to },
              aeatStatus: { in: ['rejected', 'error'] },
            },
            select: { id: true, invoiceNumber: true, aeatStatus: true },
          }),
          tx.expense.findMany({
            where: { expenseDate: { gte: from, lte: to } },
            select: {
              id: true,
              expenseDate: true,
              description: true,
              amount: true,
              baseAmount: true,
              vatAmount: true,
              vatDeductible: true,
              vendorTaxId: true,
              withholdingAmount: true,
              receiptKey: true,
            },
            orderBy: { expenseDate: 'asc' },
          }),
          tx.fiscalPeriodClosure.findFirst({
            where: { year, quarter, reopenedAt: null },
            include: { closedBy: { select: { fullName: true } } },
          }),
        ]),
      tenantId,
    );
    const [tenant, f1, numbered, drafts, rejected, expenses, closure] = data;
    const today = todayInTimezone(tenant.timezone);
    const checks: FiscalCheckDto[] = [];

    const noNif = f1.filter((inv) => {
      const nif =
        inv.customerNameSnapshot !== null
          ? inv.customerTaxIdSnapshot
          : (inv.customer?.documentNumber ?? null);
      return !nif || !nif.trim();
    });
    checks.push({
      key: 'invoices_without_nif',
      severity: 'error',
      title: 'Facturas completas sin NIF del cliente',
      detail:
        'Una factura completa (F1) tiene que llevar el NIF del cliente. Corrígela con una rectificativa o añade el dato al cliente para las siguientes.',
      count: noNif.length,
      items: noNif
        .slice(0, MAX_ITEMS)
        .map((i) => ({ label: i.invoiceNumber, href: `/invoices/${i.id}` })),
    });

    const bySeries = new Map<string, { label: string; numbers: number[] }>();
    for (const inv of numbered) {
      const entry = bySeries.get(inv.seriesId) ?? {
        label: inv.series.prefix || inv.series.name,
        numbers: [],
      };
      entry.numbers.push(inv.sequenceNumber);
      bySeries.set(inv.seriesId, entry);
    }
    const gapItems: { label: string; href: string | null }[] = [];
    for (const { label, numbers } of bySeries.values()) {
      const gaps = numberingGaps([...new Set(numbers)].sort((a, b) => a - b));
      if (gaps.length > 0) {
        gapItems.push({ label: `Serie ${label}: faltan ${gaps.join(', ')}`, href: null });
      }
    }
    checks.push({
      key: 'numbering_gaps',
      severity: 'warning',
      title: 'Saltos en la numeración',
      detail:
        'Faltan números entre las facturas emitidas este año. Si es correcto (una factura de otro programa, por ejemplo), anótalo para la asesoría.',
      count: gapItems.length,
      items: gapItems.slice(0, MAX_ITEMS),
    });

    checks.push({
      key: 'drafts_in_period',
      severity: 'warning',
      title: 'Borradores de este trimestre sin emitir',
      detail:
        'Si corresponden a este trimestre, emítelos antes de presentar; si no, cancélalos. Un borrador no cuenta en ningún modelo.',
      count: drafts.length,
      items: drafts.slice(0, MAX_ITEMS).map((d) => ({
        label: `${d.invoiceNumber.startsWith('DRAFT-') ? 'Borrador' : d.invoiceNumber} · ${eur(Number(d.total))}`,
        href: `/invoices/${d.id}`,
      })),
    });

    checks.push({
      key: 'aeat_rejected',
      severity: 'error',
      title: 'Facturas rechazadas o con error en la AEAT',
      detail: 'Veri*Factu no las ha aceptado. Ábrelas para ver el motivo y reenviarlas.',
      count: rejected.length,
      items: rejected
        .slice(0, MAX_ITEMS)
        .map((i) => ({ label: i.invoiceNumber, href: `/invoices/${i.id}` })),
    });

    const expenseItem = (e: (typeof expenses)[number]) => ({
      label: `${day(e.expenseDate)} · ${e.description} · ${eur(Number(e.amount))}`,
      href: `/expenses?expense=${e.id}`,
    });
    const unbroken = expenses.filter((e) => e.baseAmount === null);
    checks.push({
      key: 'expenses_unbroken',
      severity: 'warning',
      title: 'Gastos sin desglosar',
      detail:
        'No tienen base e IVA, así que su IVA no se resta en el 303. Desglósalos si tienes la factura.',
      count: unbroken.length,
      items: unbroken.slice(0, MAX_ITEMS).map(expenseItem),
    });
    const vatNoNif = expenses.filter(
      (e) =>
        e.baseAmount !== null && e.vatDeductible && Number(e.vatAmount ?? 0) > 0 && !e.vendorTaxId,
    );
    checks.push({
      key: 'expenses_without_nif',
      severity: 'warning',
      title: 'Gastos con IVA deducible sin NIF del proveedor',
      detail: 'Para deducir el IVA, la factura del proveedor tiene que llevar su NIF.',
      count: vatNoNif.length,
      items: vatNoNif.slice(0, MAX_ITEMS).map(expenseItem),
    });
    const whNoNif = expenses.filter((e) => Number(e.withholdingAmount ?? 0) > 0 && !e.vendorTaxId);
    checks.push({
      key: 'withholdings_without_nif',
      severity: 'warning',
      title: 'Retenciones sin NIF del perceptor',
      detail: 'El resumen anual de retenciones (190 o 180) pide el NIF de cada perceptor.',
      count: whNoNif.length,
      items: whNoNif.slice(0, MAX_ITEMS).map(expenseItem),
    });
    const noReceipt = expenses.filter((e) => e.baseAmount !== null && !e.receiptKey);
    checks.push({
      key: 'expenses_without_receipt',
      severity: 'info',
      title: 'Gastos sin justificante adjunto',
      detail: 'No es obligatorio aquí, pero conviene guardar la factura con el gasto.',
      count: noReceipt.length,
      items: noReceipt.slice(0, MAX_ITEMS).map(expenseItem),
    });

    return {
      year,
      quarter,
      ended: today > to,
      checks,
      closure: closure ? this.toDto(closure) : null,
    };
  }

  async list(tenantId: string): Promise<FiscalClosureDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.fiscalPeriodClosure.findMany({
          include: { closedBy: { select: { fullName: true } } },
          orderBy: [{ year: 'desc' }, { quarter: 'desc' }, { closedAt: 'desc' }],
          take: 40,
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async close(
    tenantId: string,
    userId: string,
    year: number,
    quarter: number,
    meta: RequestMeta,
  ): Promise<FiscalClosureDto> {
    const { to } = quarterRange(year, quarter);
    const tenant = await this.prisma.withTenant(
      (tx) => tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } }),
      tenantId,
    );
    if (todayInTimezone(tenant.timezone) <= to) {
      throw new BadRequestException({
        code: 'quarter_not_ended',
        message: 'El trimestre aún no ha terminado: se cierra cuando acabe',
      });
    }
    const [m303, withholdings] = await Promise.all([
      this.fiscal.model303(tenantId, year, quarter),
      this.fiscal.withholdings(tenantId, year, quarter),
    ]);
    const { from } = quarterRange(year, quarter);
    const expenseCount = await this.prisma.withTenant(
      (tx) => tx.expense.count({ where: { expenseDate: { gte: from, lte: to } } }),
      tenantId,
    );
    const snapshot: FiscalClosureSnapshot = {
      vatAccrued: m303.totalVat,
      vatDeductible: m303.received.vat,
      result: m303.result,
      withholding111: withholdings.models.find((m) => m.model === '111')?.amount ?? 0,
      withholding115: withholdings.models.find((m) => m.model === '115')?.amount ?? 0,
      invoiceCount: m303.invoiceCount,
      expenseCount,
    };
    try {
      const row = await this.prisma.withTenant(
        (tx) =>
          tx.fiscalPeriodClosure.create({
            data: {
              tenantId,
              year,
              quarter,
              closedByUserId: userId,
              snapshot: snapshot as unknown as object,
            },
            include: { closedBy: { select: { fullName: true } } },
          }),
        tenantId,
      );
      await this.audit.write({
        tenantId,
        userId,
        action: 'fiscal.quarter_closed',
        entityType: 'FiscalPeriodClosure',
        entityId: row.id,
        changes: { year, quarter, ...snapshot },
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      });
      return this.toDto(row);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({
          code: 'quarter_already_closed',
          message: 'Este trimestre ya está cerrado',
        });
      }
      throw err;
    }
  }

  async reopen(
    tenantId: string,
    userId: string,
    id: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<FiscalClosureDto> {
    const row = await this.prisma.withTenant(async (tx) => {
      const claimed = await tx.fiscalPeriodClosure.updateMany({
        where: { id, reopenedAt: null },
        data: { reopenedAt: new Date(), reopenedByUserId: userId, reopenReason: reason.trim() },
      });
      if (claimed.count === 0) {
        throw new NotFoundException({
          code: 'closure_not_found',
          message: 'Este cierre no existe o ya está reabierto',
        });
      }
      return tx.fiscalPeriodClosure.findUniqueOrThrow({
        where: { id },
        include: { closedBy: { select: { fullName: true } } },
      });
    }, tenantId);
    await this.audit.write({
      tenantId,
      userId,
      action: 'fiscal.quarter_reopened',
      entityType: 'FiscalPeriodClosure',
      entityId: id,
      changes: { year: row.year, quarter: row.quarter, reason: row.reopenReason },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return this.toDto(row);
  }

  private toDto(row: {
    id: string;
    year: number;
    quarter: number;
    closedAt: Date;
    snapshot: unknown;
    reopenedAt: Date | null;
    reopenReason: string | null;
    closedBy: { fullName: string } | null;
  }): FiscalClosureDto {
    return {
      id: row.id,
      year: row.year,
      quarter: row.quarter,
      closedAt: row.closedAt.toISOString(),
      closedByName: row.closedBy?.fullName ?? null,
      snapshot: row.snapshot as FiscalClosureSnapshot,
      reopenedAt: row.reopenedAt?.toISOString() ?? null,
      reopenReason: row.reopenReason,
    };
  }
}
