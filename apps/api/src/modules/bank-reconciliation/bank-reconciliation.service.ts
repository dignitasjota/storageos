import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { subtractAmounts } from '../../common/money';
import { InvoicesService } from '../billing/invoices.service';
import { PrismaService } from '../database/prisma.service';

import { parseN43 } from './n43-parser';

import type {
  BankStatementDetailDto,
  BankStatementDto,
  BankTransactionDto,
  BankTransactionSuggestionDto,
  ImportN43Input,
  ImportN43ResultDto,
} from '@storageos/shared';

interface CandidateInvoice {
  id: string;
  invoiceNumber: string;
  customerName: string;
  amountPendingCents: number;
}

function customerName(
  c: {
    customerType: string;
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
  } | null,
): string {
  if (!c) return 'Sin cliente';
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

@Injectable()
export class BankReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invoices: InvoicesService,
  ) {}

  async import(args: {
    tenantId: string;
    userId: string;
    input: ImportN43Input;
  }): Promise<ImportN43ResultDto> {
    const accounts = parseN43(args.input.content);
    if (accounts.length === 0) {
      throw new BadRequestException({
        code: 'invalid_n43',
        message: 'El fichero no contiene movimientos N43 válidos',
      });
    }
    const statements: BankStatementDto[] = [];
    for (const acc of accounts) {
      const created = await this.prisma.withTenant(
        (tx) =>
          tx.bankStatement.create({
            data: {
              tenantId: args.tenantId,
              filename: args.input.filename,
              accountLabel: acc.accountLabel,
              currency: acc.currency,
              startDate: acc.startDate ? new Date(`${acc.startDate}T00:00:00Z`) : null,
              endDate: acc.endDate ? new Date(`${acc.endDate}T00:00:00Z`) : null,
              initialBalance: acc.initialBalance,
              finalBalance: acc.finalBalance,
              transactionCount: acc.transactions.length,
              createdByUserId: args.userId,
              transactions: {
                create: acc.transactions.map((t) => ({
                  tenantId: args.tenantId,
                  operationDate: t.operationDate ? new Date(`${t.operationDate}T00:00:00Z`) : null,
                  valueDate: t.valueDate ? new Date(`${t.valueDate}T00:00:00Z`) : null,
                  amount: t.amount,
                  conceptCommon: t.conceptCommon || null,
                  conceptOwn: t.conceptOwn || null,
                  reference1: t.reference1 || null,
                  reference2: t.reference2 || null,
                  documentNumber: t.documentNumber || null,
                  description: t.description || null,
                  status: 'pending',
                })),
              },
            },
          }),
        args.tenantId,
      );
      statements.push(this.toDto(created, 0));
    }
    // Cuenta los abonos pendientes con sugerencia (informativo).
    const detail = await Promise.all(statements.map((s) => this.getStatement(args.tenantId, s.id)));
    const suggestedCount = detail.reduce(
      (sum, d) =>
        sum +
        d.transactions.filter((t) => t.status === 'pending' && t.suggestions.length > 0).length,
      0,
    );
    return { statements, suggestedCount };
  }

  async listStatements(tenantId: string): Promise<BankStatementDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.bankStatement.findMany({
          where: { tenantId },
          orderBy: { createdAt: 'desc' },
          include: { _count: { select: { transactions: { where: { status: 'matched' } } } } },
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r, r._count.transactions));
  }

  async getStatement(tenantId: string, id: string): Promise<BankStatementDetailDto> {
    const statement = await this.prisma.withTenant(
      (tx) =>
        tx.bankStatement.findFirst({
          where: { id, tenantId },
          include: { transactions: { orderBy: { operationDate: 'asc' } } },
        }),
      tenantId,
    );
    if (!statement) {
      throw new NotFoundException({
        code: 'statement_not_found',
        message: 'Extracto no encontrado',
      });
    }
    const candidates = await this.loadCandidates(tenantId);
    const paidCandidates = await this.loadPaidCandidates(tenantId);
    const matchedNumbers = await this.matchedInvoiceNumbers(
      tenantId,
      statement.transactions.map((t) => t.matchedInvoiceId).filter((x): x is string => !!x),
    );

    const transactions: BankTransactionDto[] = statement.transactions.map((t) => {
      const isCredit = t.amount >= 0;
      const reference = [t.reference1, t.reference2, t.documentNumber].filter(Boolean).join(' · ');
      const suggestions =
        isCredit && t.status === 'pending' ? this.suggest(t.amount, t, candidates) : [];
      // Cargos pendientes → posible devolución SEPA de una factura ya cobrada.
      const returnSuggestions =
        !isCredit && t.status === 'pending'
          ? this.suggestReturns(Math.abs(t.amount), t, paidCandidates)
          : [];
      return {
        id: t.id,
        operationDate: t.operationDate ? t.operationDate.toISOString().slice(0, 10) : null,
        valueDate: t.valueDate ? t.valueDate.toISOString().slice(0, 10) : null,
        amount: t.amount / 100,
        type: isCredit ? 'credit' : 'debit',
        description: t.description ?? '',
        reference,
        status: t.status as BankTransactionDto['status'],
        matchedInvoiceId: t.matchedInvoiceId,
        matchedInvoiceNumber: t.matchedInvoiceId
          ? (matchedNumbers.get(t.matchedInvoiceId) ?? null)
          : null,
        suggestions,
        returnSuggestions,
      };
    });
    const matchedCount = statement.transactions.filter((t) => t.status === 'matched').length;
    return { ...this.toDto(statement, matchedCount), transactions };
  }

  async matchTransaction(args: {
    tenantId: string;
    userId: string;
    transactionId: string;
    invoiceId: string;
  }): Promise<BankStatementDetailDto> {
    const { tenantId, transactionId, invoiceId } = args;
    const txRow = await this.prisma.withTenant(
      (tx) => tx.bankStatementTransaction.findFirst({ where: { id: transactionId, tenantId } }),
      tenantId,
    );
    if (!txRow) {
      throw new NotFoundException({
        code: 'transaction_not_found',
        message: 'Movimiento no encontrado',
      });
    }
    if (txRow.status === 'matched') {
      throw new BadRequestException({
        code: 'already_matched',
        message: 'El movimiento ya está conciliado',
      });
    }
    if (txRow.amount < 0) {
      throw new BadRequestException({
        code: 'not_a_credit',
        message: 'Solo se concilian abonos (ingresos)',
      });
    }
    // Marca la factura pagada por su importe pendiente.
    const invoice = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findFirst({
          where: { id: invoiceId, tenantId },
          select: { total: true, amountPaid: true, status: true },
        }),
      tenantId,
    );
    if (!invoice) {
      throw new NotFoundException({ code: 'invoice_not_found', message: 'Factura no encontrada' });
    }
    const pending = Math.max(0, subtractAmounts(invoice.total, invoice.amountPaid));
    if (pending > 0) {
      await this.invoices.markPaidManually({
        tenantId,
        userId: args.userId,
        invoiceId,
        input: {
          amount: pending,
          methodType: 'bank_transfer',
          notes: 'Conciliación N43',
          overridePaymentInFlight: true,
        },
        meta: {},
      });
    }
    await this.prisma.withTenant(
      (tx) =>
        tx.bankStatementTransaction.update({
          where: { id: transactionId },
          data: { status: 'matched', matchedInvoiceId: invoiceId, matchedAt: new Date() },
        }),
      tenantId,
    );
    return this.getStatement(tenantId, txRow.statementId);
  }

  /** Marca un cargo como **devolución SEPA**: revierte el cobro de la factura. */
  async markReturn(args: {
    tenantId: string;
    userId: string;
    transactionId: string;
    invoiceId: string;
  }): Promise<BankStatementDetailDto> {
    const { tenantId, transactionId, invoiceId } = args;
    const txRow = await this.prisma.withTenant(
      (tx) => tx.bankStatementTransaction.findFirst({ where: { id: transactionId, tenantId } }),
      tenantId,
    );
    if (!txRow) {
      throw new NotFoundException({
        code: 'transaction_not_found',
        message: 'Movimiento no encontrado',
      });
    }
    if (txRow.status !== 'pending') {
      throw new BadRequestException({
        code: 'already_matched',
        message: 'El movimiento ya está conciliado',
      });
    }
    if (txRow.amount >= 0) {
      throw new BadRequestException({
        code: 'not_a_debit',
        message: 'Solo los cargos pueden marcarse como devolución',
      });
    }
    const invoice = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findFirst({
          where: { id: invoiceId, tenantId },
          select: { amountPaid: true },
        }),
      tenantId,
    );
    if (!invoice) {
      throw new NotFoundException({ code: 'invoice_not_found', message: 'Factura no encontrada' });
    }
    // Revierte el cobro completo de la factura → vuelve a vencida/emitida.
    await this.invoices.revertPayment({
      tenantId,
      userId: args.userId,
      invoiceId,
      amount: Number(invoice.amountPaid),
      reason: 'Devolución SEPA (conciliación N43)',
      meta: {},
    });
    await this.prisma.withTenant(
      (tx) =>
        tx.bankStatementTransaction.update({
          where: { id: transactionId },
          data: { status: 'returned', matchedInvoiceId: invoiceId, matchedAt: new Date() },
        }),
      tenantId,
    );
    return this.getStatement(tenantId, txRow.statementId);
  }

  async ignoreTransaction(
    tenantId: string,
    transactionId: string,
  ): Promise<BankStatementDetailDto> {
    const txRow = await this.prisma.withTenant(
      (tx) =>
        tx.bankStatementTransaction.updateMany({
          where: { id: transactionId, tenantId, status: 'pending' },
          data: { status: 'ignored' },
        }),
      tenantId,
    );
    if (txRow.count === 0) {
      throw new NotFoundException({
        code: 'transaction_not_found',
        message: 'Movimiento no encontrado o ya conciliado',
      });
    }
    const found = await this.prisma.withTenant(
      (tx) =>
        tx.bankStatementTransaction.findFirst({
          where: { id: transactionId, tenantId },
          select: { statementId: true },
        }),
      tenantId,
    );
    return this.getStatement(tenantId, found!.statementId);
  }

  // -------------------------------------------------------------------------

  private async loadCandidates(tenantId: string): Promise<CandidateInvoice[]> {
    const invoices = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findMany({
          where: { tenantId, status: { in: ['issued', 'overdue'] }, deletedAt: null },
          select: {
            id: true,
            invoiceNumber: true,
            total: true,
            amountPaid: true,
            customer: {
              select: { customerType: true, firstName: true, lastName: true, companyName: true },
            },
          },
        }),
      tenantId,
    );
    return invoices
      .map((inv) => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        customerName: customerName(inv.customer),
        amountPendingCents: Math.round((Number(inv.total) - Number(inv.amountPaid)) * 100),
      }))
      .filter((c) => c.amountPendingCents > 0);
  }

  /** Sugiere facturas para un abono: importe exacto primero; referencia desempata. */
  private suggest(
    amountCents: number,
    tx: {
      reference1: string | null;
      reference2: string | null;
      documentNumber: string | null;
      description: string | null;
    },
    candidates: CandidateInvoice[],
  ): BankTransactionSuggestionDto[] {
    const haystack = [tx.reference1, tx.reference2, tx.documentNumber, tx.description]
      .filter(Boolean)
      .join(' ')
      .toUpperCase();
    const scored = candidates
      .filter((c) => c.amountPendingCents === amountCents)
      .map((c) => ({
        c,
        refMatch: haystack.includes(c.invoiceNumber.toUpperCase()),
      }))
      .sort((a, b) => Number(b.refMatch) - Number(a.refMatch));
    return scored.slice(0, 3).map(({ c }) => ({
      invoiceId: c.id,
      invoiceNumber: c.invoiceNumber,
      customerName: c.customerName,
      amountPending: c.amountPendingCents / 100,
    }));
  }

  /** Facturas ya cobradas (candidatas a una devolución SEPA en un cargo). */
  private async loadPaidCandidates(
    tenantId: string,
  ): Promise<{ id: string; invoiceNumber: string; customerName: string; paidCents: number }[]> {
    const invoices = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findMany({
          where: { tenantId, status: 'paid', deletedAt: null, amountPaid: { gt: 0 } },
          select: {
            id: true,
            invoiceNumber: true,
            amountPaid: true,
            customer: {
              select: { customerType: true, firstName: true, lastName: true, companyName: true },
            },
          },
          orderBy: { issueDate: 'desc' },
          take: 500,
        }),
      tenantId,
    );
    return invoices.map((inv) => ({
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      customerName: customerName(inv.customer),
      paidCents: Math.round(Number(inv.amountPaid) * 100),
    }));
  }

  /** Sugiere facturas pagadas cuyo importe coincide con el del cargo (devolución). */
  private suggestReturns(
    amountCents: number,
    tx: {
      reference1: string | null;
      reference2: string | null;
      documentNumber: string | null;
      description: string | null;
    },
    paid: { id: string; invoiceNumber: string; customerName: string; paidCents: number }[],
  ): BankTransactionSuggestionDto[] {
    const haystack = [tx.reference1, tx.reference2, tx.documentNumber, tx.description]
      .filter(Boolean)
      .join(' ')
      .toUpperCase();
    return paid
      .filter((c) => c.paidCents === amountCents)
      .map((c) => ({ c, refMatch: haystack.includes(c.invoiceNumber.toUpperCase()) }))
      .sort((a, b) => Number(b.refMatch) - Number(a.refMatch))
      .slice(0, 3)
      .map(({ c }) => ({
        invoiceId: c.id,
        invoiceNumber: c.invoiceNumber,
        customerName: c.customerName,
        amountPending: c.paidCents / 100,
      }));
  }

  private async matchedInvoiceNumbers(
    tenantId: string,
    ids: string[],
  ): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findMany({
          where: { tenantId, id: { in: ids } },
          select: { id: true, invoiceNumber: true },
        }),
      tenantId,
    );
    return new Map(rows.map((r) => [r.id, r.invoiceNumber]));
  }

  private toDto(
    s: {
      id: string;
      filename: string;
      accountLabel: string;
      currency: string;
      startDate: Date | null;
      endDate: Date | null;
      transactionCount: number;
      createdAt: Date;
    },
    matchedCount: number,
  ): BankStatementDto {
    return {
      id: s.id,
      filename: s.filename,
      accountLabel: s.accountLabel,
      currency: s.currency,
      startDate: s.startDate ? s.startDate.toISOString().slice(0, 10) : null,
      endDate: s.endDate ? s.endDate.toISOString().slice(0, 10) : null,
      transactionCount: s.transactionCount,
      matchedCount,
      createdAt: s.createdAt.toISOString(),
    };
  }
}
