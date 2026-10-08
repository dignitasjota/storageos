import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { NON_CASH_PAYMENT_METHODS } from '@storageos/shared';

import { toCents } from '../../common/money';
import { AuditService } from '../auth/audit.service';
import { InvoicesService } from '../billing/invoices.service';
import { PrismaService } from '../database/prisma.service';
import { markSepaItemReturned } from '../sepa/sepa-items';

import { parseN43 } from './n43-parser';

import type {
  BankReconciliationSettingsDto,
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
  private readonly logger = new Logger(BankReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly invoices: InvoicesService,
    private readonly audit: AuditService,
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
    // Conciliación automática (si el tenant la activó) de los abonos con una
    // única coincidencia exacta.
    const autoMatchedCount = (await this.autoReconcileEnabled(args.tenantId))
      ? await this.autoMatch(
          args.tenantId,
          args.userId,
          statements.map((s) => s.id),
        )
      : 0;
    // Cuenta los abonos pendientes con sugerencia (informativo).
    const detail = await Promise.all(statements.map((s) => this.getStatement(args.tenantId, s.id)));
    const suggestedCount = detail.reduce(
      (sum, d) =>
        sum +
        d.transactions.filter((t) => t.status === 'pending' && t.suggestions.length > 0).length,
      0,
    );
    return { statements, suggestedCount, autoMatchedCount };
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
        autoMatched: t.autoMatched,
      };
    });
    const matchedCount = statement.transactions.filter((t) => t.status === 'matched').length;
    return { ...this.toDto(statement, matchedCount), transactions };
  }

  async matchTransaction(args: {
    tenantId: string;
    userId: string;
    transactionId: string;
    /** Una o varias facturas: el ingreso se reparte en este orden. */
    invoiceIds: string[];
  }): Promise<BankStatementDetailDto> {
    const { tenantId, transactionId } = args;
    const invoiceIds = [...new Set(args.invoiceIds)];
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
    const invoices = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findMany({
          where: { id: { in: invoiceIds }, tenantId },
          select: { id: true, total: true, amountPaid: true },
        }),
      tenantId,
    );
    if (invoices.length !== invoiceIds.length) {
      throw new NotFoundException({ code: 'invoice_not_found', message: 'Factura no encontrada' });
    }
    // Se aplica el importe REAL del apunte (en céntimos con signo), repartido
    // por orden: a cada factura, como mucho lo que le queda pendiente. Un apunte
    // de 60 € sobre una factura de 100 € la deja con 40 € pendientes.
    let remaining = txRow.amount;
    const plan: { invoiceId: string; amount: number }[] = [];
    for (const id of invoiceIds) {
      const inv = invoices.find((i) => i.id === id)!;
      const pending = Math.max(0, toCents(inv.total) - toCents(inv.amountPaid));
      const cents = Math.min(remaining, pending);
      if (cents > 0) {
        plan.push({ invoiceId: id, amount: cents / 100 });
        remaining -= cents;
      }
    }
    // Reclamar el apunte ANTES de cobrar: un doble clic (o dos personas) no
    // aplica dos veces el mismo ingreso; el segundo ve el apunte ya conciliado.
    await this.claimTransaction(tenantId, transactionId, 'matched', invoiceIds[0]!);
    const applied: string[] = [];
    try {
      for (const part of plan) {
        await this.invoices.markPaidManually({
          tenantId,
          userId: args.userId,
          invoiceId: part.invoiceId,
          input: {
            amount: part.amount,
            methodType: 'bank_transfer',
            notes: 'Conciliación N43',
            overridePaymentInFlight: true,
            allowInSepaRemittance: true,
            // Ingreso bancario real ya confirmado: se admite el parcial no-efectivo.
            allowPartialNonCash: true,
          },
          meta: {},
        });
        applied.push(part.invoiceId);
      }
    } catch (err) {
      // Si no se aplicó nada, el apunte vuelve a quedar pendiente; si se aplicó
      // a alguna factura, queda conciliado con esas (lo demás, a mano).
      if (applied.length === 0) await this.releaseTransaction(tenantId, transactionId, 'matched');
      throw err;
    }
    return this.getStatement(tenantId, txRow.statementId);
  }

  /**
   * Reclama un apunte pendiente de forma atómica (pending → matched/returned).
   * Si otro proceso ya lo reclamó, 400 `already_matched`.
   */
  private async claimTransaction(
    tenantId: string,
    transactionId: string,
    status: 'matched' | 'returned',
    invoiceId: string,
  ): Promise<void> {
    const { count } = await this.prisma.withTenant(
      (tx) =>
        tx.bankStatementTransaction.updateMany({
          where: { id: transactionId, status: 'pending' },
          data: { status, matchedInvoiceId: invoiceId, matchedAt: new Date() },
        }),
      tenantId,
    );
    if (count === 0) {
      throw new BadRequestException({
        code: 'already_matched',
        message: 'El movimiento ya está conciliado',
      });
    }
  }

  /** Deshace la reclamación si el cobro o la devolución fallaron. */
  private async releaseTransaction(
    tenantId: string,
    transactionId: string,
    status: 'matched' | 'returned',
  ): Promise<void> {
    await this.prisma.withTenant(
      (tx) =>
        tx.bankStatementTransaction.updateMany({
          where: { id: transactionId, status },
          data: { status: 'pending', matchedInvoiceId: null, matchedAt: null },
        }),
      tenantId,
    );
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
          select: {
            amountPaid: true,
            payments: {
              where: { status: 'succeeded', methodType: { in: [...NON_CASH_PAYMENT_METHODS] } },
              select: { amount: true },
            },
          },
        }),
      tenantId,
    );
    if (!invoice) {
      throw new NotFoundException({ code: 'invoice_not_found', message: 'Factura no encontrada' });
    }
    // Lo cobrado en dinero (sin retención de IRPF ni abonos): es lo único que
    // el banco puede devolver.
    const cashPaidCents =
      toCents(invoice.amountPaid) - invoice.payments.reduce((sum, p) => sum + toCents(p.amount), 0);
    await this.claimTransaction(tenantId, transactionId, 'returned', invoiceId);
    try {
      // Se revierte el importe DEVUELTO por el banco (el cargo), no todo lo
      // cobrado: una devolución de 60 € sobre una factura cobrada en dos partes
      // no borra también la otra.
      await this.invoices.revertPayment({
        tenantId,
        userId: args.userId,
        invoiceId,
        amount: Math.min(Math.abs(txRow.amount), Math.max(0, cashPaidCents)) / 100,
        reason: 'Devolución SEPA (conciliación N43)',
        meta: {},
      });
    } catch (err) {
      await this.releaseTransaction(tenantId, transactionId, 'returned');
      throw err;
    }
    // Si era un adeudo de remesa, queda «devuelto»: la factura puede volver
    // a presentarse en otra remesa.
    await this.prisma.withTenant((tx) => markSepaItemReturned(tx, invoiceId), tenantId);
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

  // ------------------------------------------------- conciliación automática

  async getSettings(tenantId: string): Promise<BankReconciliationSettingsDto> {
    return { autoReconcile: await this.autoReconcileEnabled(tenantId) };
  }

  async updateSettings(args: {
    tenantId: string;
    userId: string;
    autoReconcile: boolean;
  }): Promise<BankReconciliationSettingsDto> {
    await this.prisma.withTenant(
      (tx) =>
        tx.tenant.update({
          where: { id: args.tenantId },
          data: { bankAutoReconcile: args.autoReconcile },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'bank_reconciliation.settings_changed',
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes: { autoReconcile: args.autoReconcile },
    });
    return { autoReconcile: args.autoReconcile };
  }

  private async autoReconcileEnabled(tenantId: string): Promise<boolean> {
    const tenant = await this.prisma.withTenant(
      (tx) =>
        tx.tenant.findUnique({ where: { id: tenantId }, select: { bankAutoReconcile: true } }),
      tenantId,
    );
    return tenant?.bankAutoReconcile ?? false;
  }

  /**
   * Concilia solos los abonos pendientes de estos extractos que casan con UNA
   * sola factura: importe exacto de lo pendiente y su número en el concepto o
   * la referencia. Ante cualquier duda (ninguna o varias) se deja a mano. Cada
   * apunte se reclama antes de cobrar (sin dobles cobros con otra persona
   * conciliando a la vez) y queda marcado como automático.
   */
  private async autoMatch(
    tenantId: string,
    userId: string,
    statementIds: string[],
  ): Promise<number> {
    const txs = await this.prisma.withTenant(
      (tx) =>
        tx.bankStatementTransaction.findMany({
          where: { statementId: { in: statementIds }, status: 'pending', amount: { gt: 0 } },
          orderBy: { operationDate: 'asc' },
        }),
      tenantId,
    );
    if (txs.length === 0) return 0;
    const candidates = await this.loadCandidates(tenantId);
    const used = new Set<string>();
    let matched = 0;
    for (const t of txs) {
      const hits = uniqueAutoMatch(t.amount, t, candidates).filter((c) => !used.has(c.id));
      if (hits.length !== 1) continue;
      const invoice = hits[0]!;
      const { count } = await this.prisma.withTenant(
        (tx) =>
          tx.bankStatementTransaction.updateMany({
            where: { id: t.id, status: 'pending' },
            data: {
              status: 'matched',
              matchedInvoiceId: invoice.id,
              matchedAt: new Date(),
              autoMatched: true,
            },
          }),
        tenantId,
      );
      if (count === 0) continue;
      used.add(invoice.id);
      try {
        await this.invoices.markPaidManually({
          tenantId,
          userId,
          invoiceId: invoice.id,
          input: {
            amount: t.amount / 100,
            methodType: 'bank_transfer',
            notes: 'Conciliación N43 automática',
            overridePaymentInFlight: true,
            allowInSepaRemittance: true,
            allowPartialNonCash: true,
          },
          meta: {},
        });
        const payment = await this.prisma.withTenant(
          (tx) =>
            tx.payment.findFirst({
              where: { invoiceId: invoice.id, notes: 'Conciliación N43 automática' },
              orderBy: { createdAt: 'desc' },
              select: { id: true },
            }),
          tenantId,
        );
        await this.prisma.withTenant(
          (tx) =>
            tx.bankStatementTransaction.update({
              where: { id: t.id },
              data: { matchedPaymentId: payment?.id ?? null },
            }),
          tenantId,
        );
        matched += 1;
      } catch (err) {
        this.logger.warn(
          `[bank] conciliación automática fallida (${t.id}): ${err instanceof Error ? err.message : String(err)}`,
        );
        await this.prisma.withTenant(
          (tx) =>
            tx.bankStatementTransaction.updateMany({
              where: { id: t.id, status: 'matched' },
              data: {
                status: 'pending',
                matchedInvoiceId: null,
                matchedAt: null,
                autoMatched: false,
              },
            }),
          tenantId,
        );
      }
    }
    return matched;
  }

  /** Deshace una conciliación automática: anula ese cobro y el apunte vuelve a pendiente. */
  async undoAutoMatch(args: {
    tenantId: string;
    userId: string;
    transactionId: string;
  }): Promise<BankStatementDetailDto> {
    const t = await this.prisma.withTenant(
      (tx) =>
        tx.bankStatementTransaction.findFirst({
          where: { id: args.transactionId, tenantId: args.tenantId },
        }),
      args.tenantId,
    );
    if (!t) {
      throw new NotFoundException({
        code: 'transaction_not_found',
        message: 'Movimiento no encontrado',
      });
    }
    if (t.status !== 'matched' || !t.autoMatched || !t.matchedInvoiceId || !t.matchedPaymentId) {
      throw new BadRequestException({
        code: 'not_auto_matched',
        message: 'Solo se deshacen las conciliaciones automáticas',
      });
    }
    // Reclamar el deshacer: dos clics no anulan el cobro dos veces.
    const { count } = await this.prisma.withTenant(
      (tx) =>
        tx.bankStatementTransaction.updateMany({
          where: { id: t.id, status: 'matched', autoMatched: true },
          data: { status: 'pending', matchedInvoiceId: null, matchedAt: null, autoMatched: false },
        }),
      args.tenantId,
    );
    if (count === 0) {
      throw new BadRequestException({
        code: 'not_auto_matched',
        message: 'Solo se deshacen las conciliaciones automáticas',
      });
    }
    try {
      await this.invoices.revertPayment({
        tenantId: args.tenantId,
        userId: args.userId,
        invoiceId: t.matchedInvoiceId,
        amount: t.amount / 100,
        paymentId: t.matchedPaymentId,
        undo: true,
        reason: 'Conciliación automática deshecha',
        meta: {},
      });
    } catch (err) {
      await this.prisma.withTenant(
        (tx) =>
          tx.bankStatementTransaction.update({
            where: { id: t.id },
            data: {
              status: 'matched',
              matchedInvoiceId: t.matchedInvoiceId,
              matchedAt: t.matchedAt,
              autoMatched: true,
            },
          }),
        args.tenantId,
      );
      throw err;
    }
    await this.prisma.withTenant(
      (tx) =>
        tx.bankStatementTransaction.update({
          where: { id: t.id },
          data: { matchedPaymentId: null },
        }),
      args.tenantId,
    );
    return this.getStatement(args.tenantId, t.statementId);
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
            // Retenciones de IRPF y abonos: cuentan como pagado pero no son
            // dinero del banco (una devolución nunca los incluye).
            payments: {
              where: { status: 'succeeded', methodType: { in: [...NON_CASH_PAYMENT_METHODS] } },
              select: { amount: true },
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
      paidCents:
        toCents(inv.amountPaid) - inv.payments.reduce((sum, p) => sum + toCents(p.amount), 0),
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

/**
 * El número de factura aparece como palabra suelta en el texto del apunte
 * (`F-2026-1` no casa dentro de `F-2026-12`).
 */
export function containsInvoiceNumber(haystack: string, invoiceNumber: string): boolean {
  const escaped = invoiceNumber.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Z0-9])${escaped}($|[^A-Z0-9])`).test(haystack.toUpperCase());
}

/** Facturas que casan para la conciliación automática: importe exacto + número en el texto. */
export function uniqueAutoMatch<T extends { invoiceNumber: string; amountPendingCents: number }>(
  amountCents: number,
  tx: {
    reference1: string | null;
    reference2: string | null;
    documentNumber: string | null;
    description: string | null;
  },
  candidates: T[],
): T[] {
  const haystack = [tx.reference1, tx.reference2, tx.documentNumber, tx.description]
    .filter(Boolean)
    .join(' ');
  return candidates.filter(
    (c) => c.amountPendingCents === amountCents && containsInvoiceNumber(haystack, c.invoiceNumber),
  );
}
