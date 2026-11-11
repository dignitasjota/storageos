import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  bankTextContains,
  findInvoiceSubset,
  findReturnCode,
  guessPayerPattern,
  nameMatches,
  normalizeBankText,
  returnCodeLabel,
} from '@storageos/shared';

import { zonedDayStart } from '../../common/format';
import { toCents } from '../../common/money';
import { isUniqueViolation } from '../../common/prisma-errors';
import { AuditService } from '../auth/audit.service';
import { InvoicesService } from '../billing/invoices.service';
import { PrismaService } from '../database/prisma.service';
import { ExpensesService } from '../expenses/expenses.service';
import { markSepaItemCollectedAgain, markSepaItemReturned } from '../sepa/sepa-items';
import { SepaService } from '../sepa/sepa.service';

import { parseBankCsv } from './bank-csv';
import { parseN43File, type N43Account } from './n43-parser';

import type { RequestMeta } from '../auth/auth.service';
import type { Prisma } from '@storageos/database';
import type {
  BankMatchRuleDto,
  BankMatchRuleKind,
  BankReconciliationSettingsDto,
  BankRemittanceSuggestionDto,
  BankStatementDetailDto,
  BankStatementDto,
  BankSurplusHandling,
  BankTransactionDto,
  BankTransactionSuggestionDto,
  ClassifyExpenseInput,
  CreateBankMatchRuleInput,
  ImportBankCsvInput,
  ImportN43Input,
  ImportN43ResultDto,
} from '@storageos/shared';

interface CandidateInvoice {
  id: string;
  invoiceNumber: string;
  customerId: string | null;
  customerName: string;
  amountPendingCents: number;
  /** En una remesa SEPA sin confirmar o con un cobro por pasarela en curso. */
  inFlight: boolean;
}

interface RuleRow {
  id: string;
  pattern: string;
  kind: string;
  customerId: string | null;
  expenseCategory: string | null;
}

interface RemittanceCandidate {
  id: string;
  name: string;
  status: 'generated' | 'confirmed';
  collectionDate: Date;
  /** Lo que el banco abona: los adeudos pendientes y cobrados (céntimos). */
  expectedCents: number;
  /** Ya tiene su abono conciliado. */
  matched: boolean;
}

/** El texto de un apunte en el que se buscan nombres y reglas. */
function transactionText(t: {
  description: string | null;
  conceptOwn: string | null;
  reference1: string | null;
  reference2: string | null;
}): string {
  return [t.description, t.conceptOwn, t.reference1, t.reference2].filter(Boolean).join(' ');
}

/** Días entre dos fechas (sin hora). */
function daysApart(a: Date, b: Date): number {
  return Math.abs(Math.round((a.getTime() - b.getTime()) / 86_400_000));
}

interface ReturnCandidate {
  paymentId: string;
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
  amountCents: number;
  paidAt: Date | null;
  methodType: string;
}

/** Cobros que el banco puede devolver: los que entraron por el banco. */
const BANK_METHODS = ['bank_transfer', 'sepa_debit'] as const;

/** Cuánto se busca hacia atrás un cobro devuelto (una devolución SEPA llega en semanas). */
const RETURN_LOOKBACK_DAYS = 400;

type TransactionRow = Prisma.BankStatementTransactionGetPayload<object>;

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

/** Fichero sin espacios finales ni líneas vacías: dos descargas iguales dan la misma huella. */
function normalizedContent(content: string): string {
  return content
    .split(/\r\n|\r|\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .join('\n');
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Huella de cada movimiento: los mismos datos en la misma cuenta. Dos
 * movimientos idénticos en un mismo extracto (dos transferencias iguales el
 * mismo día) se distinguen por su orden.
 */
function fingerprints(account: N43Account): string[] {
  const seen = new Map<string, number>();
  return account.transactions.map((t) => {
    const key = [
      account.accountLabel,
      t.operationDate ?? '',
      t.valueDate ?? '',
      t.amount,
      t.conceptCommon,
      t.conceptOwn,
      t.documentNumber,
      t.reference1,
      t.reference2,
      t.description,
    ].join('|');
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return sha256(`${key}#${n}`);
  });
}

function isoDate(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

@Injectable()
export class BankReconciliationService {
  private readonly logger = new Logger(BankReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly invoices: InvoicesService,
    private readonly audit: AuditService,
    private readonly sepa: SepaService,
    private readonly expenses: ExpensesService,
  ) {}

  // ---------------------------------------------------------------- importar

  async import(args: {
    tenantId: string;
    userId: string;
    input: ImportN43Input;
    meta?: RequestMeta;
  }): Promise<ImportN43ResultDto> {
    const parsed = parseN43File(args.input.content);
    if (parsed.accounts.length === 0) {
      throw new BadRequestException({
        code: 'invalid_n43',
        message: 'El fichero no contiene movimientos N43 válidos',
      });
    }
    return this.importAccounts({
      ...args,
      accounts: parsed.accounts,
      extraWarnings: parsed.warnings,
      source: 'n43',
    });
  }

  /**
   * El CSV de movimientos de la banca online: las columnas se reconocen por su
   * título o se indican a mano (400 `csv_columns_unknown` con los títulos).
   */
  async importCsv(args: {
    tenantId: string;
    userId: string;
    input: ImportBankCsvInput;
    meta?: RequestMeta;
  }): Promise<ImportN43ResultDto> {
    const parsed = parseBankCsv(args.input.content, args.input.mapping);
    if (!parsed.mapping) {
      throw new BadRequestException({
        code: 'csv_columns_unknown',
        message:
          'No se reconocen las columnas del fichero: indica cuál es la fecha, el concepto y el importe.',
        details: { headers: parsed.headers, sample: parsed.sample },
      });
    }
    if (!parsed.account || parsed.account.transactions.length === 0) {
      throw new BadRequestException({
        code: 'invalid_bank_csv',
        message: 'El fichero no tiene movimientos con fecha e importe.',
        details: { headers: parsed.headers, sample: parsed.sample },
      });
    }
    return this.importAccounts({
      ...args,
      input: { filename: args.input.filename, content: args.input.content },
      accounts: [
        {
          ...parsed.account,
          accountLabel: parsed.account.accountLabel || args.input.filename,
        },
      ],
      extraWarnings: [],
      source: 'csv',
    });
  }

  private async importAccounts(args: {
    tenantId: string;
    userId: string;
    input: ImportN43Input;
    accounts: N43Account[];
    extraWarnings: string[];
    source: 'n43' | 'csv';
    meta?: RequestMeta;
  }): Promise<ImportN43ResultDto> {
    const parsed = { accounts: args.accounts, warnings: args.extraWarnings };
    const base = normalizedContent(args.input.content);
    let duplicatesSkipped = 0;
    let created: { id: string }[];
    try {
      created = await this.prisma.withTenant(
        async (tx) => {
          const out: { id: string }[] = [];
          for (const [index, acc] of parsed.accounts.entries()) {
            const fileHash = sha256(`${base}#${index}`);
            const existing = await tx.bankStatement.findFirst({
              where: { tenantId: args.tenantId, fileHash },
              select: { id: true },
            });
            if (existing) throw this.alreadyImported(existing.id);
            const statement = await tx.bankStatement.create({
              data: {
                tenantId: args.tenantId,
                source: args.source,
                filename: args.input.filename,
                accountLabel: acc.accountLabel,
                currency: acc.currency,
                startDate: acc.startDate ? new Date(`${acc.startDate}T00:00:00Z`) : null,
                endDate: acc.endDate ? new Date(`${acc.endDate}T00:00:00Z`) : null,
                initialBalance: acc.initialBalance,
                finalBalance: acc.finalBalance,
                transactionCount: 0,
                fileHash,
                warnings: [...acc.warnings, ...parsed.warnings],
                createdByUserId: args.userId,
              },
              select: { id: true },
            });
            const prints = fingerprints(acc);
            const { count } = await tx.bankStatementTransaction.createMany({
              data: acc.transactions.map((t, i) => ({
                tenantId: args.tenantId,
                statementId: statement.id,
                operationDate: t.operationDate ? new Date(`${t.operationDate}T00:00:00Z`) : null,
                valueDate: t.valueDate ? new Date(`${t.valueDate}T00:00:00Z`) : null,
                amount: t.amount,
                conceptCommon: t.conceptCommon || null,
                conceptOwn: t.conceptOwn || null,
                reference1: t.reference1 || null,
                reference2: t.reference2 || null,
                documentNumber: t.documentNumber || null,
                description: t.description || null,
                fingerprint: prints[i]!,
                status: 'pending',
              })),
              // Un movimiento que ya está en otro extracto (descargas que se
              // solapan) no se repite.
              skipDuplicates: true,
            });
            duplicatesSkipped += acc.transactions.length - count;
            if (count === 0 && acc.transactions.length > 0) {
              // Todo repetido: el extracto no aporta nada.
              await tx.bankStatement.delete({ where: { id: statement.id } });
              continue;
            }
            await tx.bankStatement.update({
              where: { id: statement.id },
              data: { transactionCount: count },
            });
            out.push(statement);
          }
          if (out.length === 0) {
            throw new ConflictException({
              code: 'statement_already_imported',
              message: 'Todos los movimientos de este fichero ya estaban importados.',
            });
          }
          return out;
        },
        args.tenantId,
        { timeout: 30_000 },
      );
    } catch (err) {
      // Dos importaciones del mismo fichero a la vez: la segunda choca con la huella.
      if (isUniqueViolation(err)) throw this.alreadyImported(null);
      throw err;
    }
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'bank_reconciliation.imported',
      entityType: 'BankStatement',
      entityId: created[0]!.id,
      changes: {
        filename: args.input.filename,
        source: args.source,
        statements: created.length,
        duplicatesSkipped,
      },
      ipAddress: args.meta?.ipAddress ?? null,
      userAgent: args.meta?.userAgent ?? null,
    });
    const ids = created.map((s) => s.id);
    // Conciliación automática (si el tenant la activó) de los abonos con una
    // única coincidencia exacta.
    const autoMatchedCount = (await this.autoReconcileEnabled(args.tenantId))
      ? await this.autoMatch(args.tenantId, args.userId, ids)
      : 0;
    const details = await Promise.all(ids.map((id) => this.getStatement(args.tenantId, id)));
    const suggestedCount = details.reduce(
      (sum, d) =>
        sum +
        d.transactions.filter((t) => t.status === 'pending' && t.suggestions.length > 0).length,
      0,
    );
    const warnings = [...new Set(details.flatMap((d) => d.warnings))];
    return {
      statements: details.map(({ transactions: _t, ...dto }) => dto),
      suggestedCount,
      autoMatchedCount,
      duplicatesSkipped,
      warnings,
    };
  }

  private alreadyImported(statementId: string | null): ConflictException {
    return new ConflictException({
      code: 'statement_already_imported',
      message: 'Este extracto ya está importado.',
      ...(statementId ? { details: { statementId } } : {}),
    });
  }

  /** Borra un extracto sin nada conciliado ni devuelto (p. ej. el fichero equivocado). */
  async deleteStatement(args: {
    tenantId: string;
    userId: string;
    statementId: string;
    meta?: RequestMeta;
  }): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      const statement = await tx.bankStatement.findFirst({
        where: { id: args.statementId, tenantId: args.tenantId },
        select: { id: true },
      });
      if (!statement) throw this.statementNotFound();
      const used = await tx.bankStatementTransaction.count({
        where: { statementId: args.statementId, status: { in: ['matched', 'returned'] } },
      });
      if (used > 0) {
        throw new ConflictException({
          code: 'statement_has_matches',
          message:
            'Este extracto tiene movimientos conciliados o devueltos: deshazlos antes de borrarlo.',
        });
      }
      await tx.bankStatement.delete({ where: { id: args.statementId } });
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'bank_reconciliation.statement_deleted',
      entityType: 'BankStatement',
      entityId: args.statementId,
      changes: {},
      ipAddress: args.meta?.ipAddress ?? null,
      userAgent: args.meta?.userAgent ?? null,
    });
  }

  // ---------------------------------------------------------------- consultar

  async listStatements(tenantId: string): Promise<BankStatementDto[]> {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.bankStatement.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
      });
      const counts = await tx.bankStatementTransaction.groupBy({
        by: ['statementId', 'status'],
        where: { statementId: { in: rows.map((r) => r.id) } },
        _count: { _all: true },
      });
      const count = (id: string, status: string) =>
        counts.find((c) => c.statementId === id && c.status === status)?._count._all ?? 0;
      return rows.map((r) => this.toDto(r, count(r.id, 'matched'), count(r.id, 'pending')));
    }, tenantId);
  }

  async getStatement(tenantId: string, id: string): Promise<BankStatementDetailDto> {
    const statement = await this.prisma.withTenant(
      (tx) =>
        tx.bankStatement.findFirst({
          where: { id, tenantId },
          include: {
            transactions: {
              orderBy: [{ operationDate: 'asc' }, { id: 'asc' }],
              include: {
                matchedRemittance: { select: { id: true, name: true } },
                expense: { select: { id: true, category: true } },
              },
            },
          },
        }),
      tenantId,
    );
    if (!statement) throw this.statementNotFound();
    const hasPendingCredit = statement.transactions.some(
      (t) => t.status === 'pending' && t.amount > 0,
    );
    const hasPendingDebit = statement.transactions.some(
      (t) => t.status === 'pending' && t.amount < 0,
    );
    const candidates = hasPendingCredit ? await this.loadCandidates(tenantId) : [];
    const returnCandidates = hasPendingDebit ? await this.loadReturnCandidates(tenantId) : [];
    const remittances = hasPendingCredit ? await this.loadRemittanceCandidates(tenantId) : [];
    const rules = hasPendingCredit || hasPendingDebit ? await this.loadRules(tenantId) : [];
    const linked = await this.linkedInvoices(tenantId, statement.transactions);

    const transactions: BankTransactionDto[] = statement.transactions.map((t) => {
      const isCredit = t.amount >= 0;
      const reference = [t.reference1, t.reference2, t.documentNumber].filter(Boolean).join(' · ');
      const pending = t.status === 'pending';
      const text = transactionText(t);
      const suggestions =
        isCredit && t.amount > 0 && pending ? this.suggest(t.amount, t, candidates, rules) : [];
      const remittanceSuggestions =
        isCredit && t.amount > 0 && pending ? this.suggestRemittances(t, remittances) : [];
      const expenseRule =
        !isCredit && pending
          ? rules.find((r) => r.kind === 'expense' && bankTextContains(text, r.pattern))
          : undefined;
      // Cargos pendientes → posible devolución de un cobro por banco.
      const returnSuggestions =
        !isCredit && t.status === 'pending'
          ? this.suggestReturns(Math.abs(t.amount), t, returnCandidates)
          : [];
      const matchedInvoices = linked.get(t.id) ?? [];
      return {
        id: t.id,
        operationDate: isoDate(t.operationDate),
        valueDate: isoDate(t.valueDate),
        amount: t.amount / 100,
        type: isCredit ? 'credit' : 'debit',
        description: t.description ?? '',
        reference,
        status: t.status as BankTransactionDto['status'],
        matchedInvoiceId: t.matchedInvoiceId,
        matchedInvoiceNumber: t.matchedInvoiceId
          ? (matchedInvoices.find((i) => i.id === t.matchedInvoiceId)?.invoiceNumber ??
            matchedInvoices[0]?.invoiceNumber ??
            null)
          : null,
        matchedInvoices,
        unappliedAmount: t.unappliedAmount / 100,
        creditContractId: t.creditContractId,
        suggestions,
        returnSuggestions,
        remittanceSuggestions,
        matchedRemittance: t.matchedRemittance ?? null,
        expense: t.expense ?? null,
        expenseSuggestion: expenseRule
          ? { category: expenseRule.expenseCategory ?? 'other', pattern: expenseRule.pattern }
          : null,
        payerPattern: pending ? guessPayerPattern(text) : '',
        autoMatched: t.autoMatched,
        canUndo: this.canUndo(t),
      };
    });
    const matchedCount = statement.transactions.filter((t) => t.status === 'matched').length;
    const pendingCount = statement.transactions.filter((t) => t.status === 'pending').length;
    return { ...this.toDto(statement, matchedCount, pendingCount), transactions };
  }

  /** Lo conciliado, devuelto o ignorado que se puede deshacer. */
  private canUndo(t: TransactionRow): boolean {
    if (t.status === 'ignored' || t.status === 'expense') return true;
    if (t.status === 'matched' && t.matchedRemittanceId) return true;
    if (t.status === 'matched' || t.status === 'returned') {
      return t.matchedPaymentIds.length > 0 || !!t.matchedPaymentId;
    }
    return false;
  }

  // ---------------------------------------------------------------- conciliar

  async matchTransaction(args: {
    tenantId: string;
    userId: string;
    transactionId: string;
    /** Una o varias facturas: el ingreso se reparte en este orden. */
    invoiceIds: string[];
    surplus?: BankSurplusHandling;
    /** Recordar: si el concepto lleva esto, es de este inquilino. */
    rememberPattern?: string;
    meta?: RequestMeta;
  }): Promise<BankStatementDetailDto> {
    const { tenantId, transactionId } = args;
    const invoiceIds = [...new Set(args.invoiceIds)];
    const txRow = await this.findTransaction(tenantId, transactionId);
    if (txRow.status !== 'pending') throw this.notPending();
    if (txRow.amount <= 0) {
      throw new BadRequestException({
        code: 'not_a_credit',
        message: 'Solo se concilian abonos (ingresos)',
      });
    }
    const invoices = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findMany({
          where: { id: { in: invoiceIds }, tenantId, deletedAt: null },
          select: {
            id: true,
            total: true,
            amountPaid: true,
            status: true,
            contractId: true,
            customerId: true,
          },
        }),
      tenantId,
    );
    if (invoices.length !== invoiceIds.length) {
      throw new NotFoundException({ code: 'invoice_not_found', message: 'Factura no encontrada' });
    }
    // Se aplica el importe REAL del apunte (en céntimos), repartido por orden:
    // a cada factura, como mucho, lo que le queda pendiente.
    let remaining = txRow.amount;
    const plan: { invoiceId: string; cents: number }[] = [];
    for (const id of invoiceIds) {
      const inv = invoices.find((i) => i.id === id)!;
      if (inv.status !== 'issued' && inv.status !== 'overdue') continue;
      const pending = Math.max(0, toCents(inv.total) - toCents(inv.amountPaid));
      const cents = Math.min(remaining, pending);
      if (cents > 0) {
        plan.push({ invoiceId: id, cents });
        remaining -= cents;
      }
    }
    if (plan.length === 0) {
      throw new BadRequestException({
        code: 'nothing_to_apply',
        message: 'Las facturas elegidas ya no tienen nada pendiente de cobro.',
      });
    }
    // Lo que sobra del abono: hay que decir qué hacer con ello.
    let creditContractId: string | null = null;
    if (remaining > 0) {
      if (!args.surplus) {
        throw new BadRequestException({
          code: 'transaction_surplus',
          message: `El ingreso es ${(remaining / 100).toFixed(2).replace('.', ',')} € mayor que lo pendiente de esas facturas: indica si queda como saldo a favor o se le devuelve.`,
          details: { surplus: remaining / 100 },
        });
      }
      if (args.surplus === 'credit') {
        creditContractId =
          [...plan]
            .reverse()
            .map((p) => invoices.find((i) => i.id === p.invoiceId)?.contractId)
            .find((c): c is string => !!c) ?? null;
        if (!creditContractId) {
          throw new BadRequestException({
            code: 'surplus_needs_contract',
            message:
              'Para dejar el sobrante como saldo a favor, alguna de las facturas tiene que ser de un contrato.',
          });
        }
      }
    }
    // Reclamar el apunte ANTES de cobrar: un doble clic (o dos personas) no
    // aplica dos veces el mismo ingreso; el segundo ve el apunte ya conciliado.
    await this.claim(tenantId, transactionId, 'pending', {
      status: 'matched',
      matchedInvoiceId: plan[0]!.invoiceId,
      matchedAt: new Date(),
    });
    const paidAt = await this.movementInstant(tenantId, txRow);
    const paymentIds: string[] = [];
    try {
      for (const part of plan) {
        const { paymentId } = await this.invoices.registerManualPayment({
          tenantId,
          userId: args.userId,
          invoiceId: part.invoiceId,
          input: {
            amount: part.cents / 100,
            paidAt: paidAt.toISOString(),
            methodType: 'bank_transfer',
            notes: 'Conciliación N43',
            overridePaymentInFlight: true,
            allowInSepaRemittance: true,
            // Ingreso bancario real ya confirmado: se admite el parcial no-efectivo.
            allowPartialNonCash: true,
          },
          meta: args.meta ?? {},
        });
        paymentIds.push(paymentId);
      }
    } catch (err) {
      // Si no se aplicó nada, el apunte vuelve a quedar pendiente; si se aplicó
      // a alguna factura, queda conciliado con esas (lo demás, a mano).
      if (paymentIds.length === 0) {
        await this.release(tenantId, transactionId, 'matched');
      } else {
        const applied = plan.slice(0, paymentIds.length).reduce((s, p) => s + p.cents, 0);
        await this.updateTransaction(tenantId, transactionId, {
          matchedPaymentIds: paymentIds,
          matchedPaymentId: paymentIds[0]!,
          unappliedAmount: txRow.amount - applied,
        });
      }
      throw err;
    }
    await this.prisma.withTenant(async (tx) => {
      await tx.bankStatementTransaction.update({
        where: { id: transactionId },
        data: {
          matchedPaymentIds: paymentIds,
          matchedPaymentId: paymentIds[0]!,
          unappliedAmount: remaining,
          creditContractId,
        },
      });
      if (creditContractId && remaining > 0) {
        await tx.contract.update({
          where: { id: creditContractId },
          data: { creditBalance: { increment: remaining / 100 } },
        });
      }
    }, tenantId);
    await this.audit.write({
      tenantId,
      userId: args.userId,
      action: 'bank_reconciliation.matched',
      entityType: 'BankStatementTransaction',
      entityId: transactionId,
      changes: {
        invoiceIds: plan.map((p) => p.invoiceId),
        paymentIds,
        surplus: remaining / 100,
        surplusHandling: remaining > 0 ? (args.surplus ?? null) : null,
      },
      ipAddress: args.meta?.ipAddress ?? null,
      userAgent: args.meta?.userAgent ?? null,
    });
    // Reglas: la que se pide recordar y las que ya acertaron con este inquilino.
    const customerId = invoices.find((i) => i.id === plan[0]!.invoiceId)?.customerId ?? null;
    if (customerId) {
      if (args.rememberPattern) {
        await this.rememberRule(tenantId, args.userId, {
          pattern: args.rememberPattern,
          kind: 'customer',
          customerId,
        });
      }
      await this.countRuleHits(tenantId, 'customer', transactionText(txRow), { customerId });
    }
    return this.getStatement(tenantId, txRow.statementId);
  }

  /**
   * El abono de una remesa SEPA de una vez: el banco ingresa el total de los
   * adeudos cobrados. Si la remesa aún no se había registrado, se registra
   * (todos sus adeudos pendientes, cobrados con la fecha del cargo).
   */
  async matchRemittance(args: {
    tenantId: string;
    userId: string;
    transactionId: string;
    remittanceId: string;
    meta?: RequestMeta;
  }): Promise<BankStatementDetailDto> {
    const { tenantId, transactionId, remittanceId } = args;
    const txRow = await this.findTransaction(tenantId, transactionId);
    if (txRow.status !== 'pending') throw this.notPending();
    if (txRow.amount <= 0) {
      throw new BadRequestException({
        code: 'not_a_credit',
        message: 'Solo se concilian abonos (ingresos)',
      });
    }
    const [candidate] = await this.loadRemittanceCandidates(tenantId, remittanceId, {
      includeMatched: true,
    });
    if (!candidate) {
      throw new NotFoundException({
        code: 'remittance_not_found',
        message: 'Esa remesa no existe, está cancelada o no tiene adeudos cobrados.',
      });
    }
    if (candidate.matched) throw this.remittanceAlreadyMatched();
    if (candidate.expectedCents !== txRow.amount) {
      throw new BadRequestException({
        code: 'remittance_amount_mismatch',
        message: `El ingreso no es el total de la remesa (${(candidate.expectedCents / 100)
          .toFixed(2)
          .replace('.', ',')} €). Si el banco rechazó o devolvió algún adeudo, regístralo antes.`,
        details: { expected: candidate.expectedCents / 100, amount: txRow.amount / 100 },
      });
    }
    // Con la remesa bloqueada: dos ingresos a la vez no se quedan la misma.
    await this.prisma.withTenant(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM sepa_remittances WHERE id = ${remittanceId}::uuid FOR UPDATE`;
      const taken = await tx.bankStatementTransaction.count({
        where: { matchedRemittanceId: remittanceId, status: 'matched' },
      });
      if (taken > 0) throw this.remittanceAlreadyMatched();
      const { count } = await tx.bankStatementTransaction.updateMany({
        where: { id: transactionId, status: 'pending' },
        data: { status: 'matched', matchedRemittanceId: remittanceId, matchedAt: new Date() },
      });
      if (count === 0) throw this.notPending();
    }, tenantId);
    if (candidate.status === 'generated') {
      try {
        await this.sepa.confirmRemittance(tenantId, args.userId, remittanceId, {});
      } catch (err) {
        await this.prisma.withTenant(
          (tx) =>
            tx.bankStatementTransaction.updateMany({
              where: { id: transactionId, status: 'matched' },
              data: { status: 'pending', matchedRemittanceId: null, matchedAt: null },
            }),
          tenantId,
        );
        throw err;
      }
    }
    await this.audit.write({
      tenantId,
      userId: args.userId,
      action: 'bank_reconciliation.remittance_matched',
      entityType: 'BankStatementTransaction',
      entityId: transactionId,
      changes: { remittanceId, confirmed: candidate.status === 'generated' },
      ipAddress: args.meta?.ipAddress ?? null,
      userAgent: args.meta?.userAgent ?? null,
    });
    return this.getStatement(tenantId, txRow.statementId);
  }

  /** Un cargo que es un gasto del negocio: queda en Gastos con su categoría. */
  async classifyExpense(args: {
    tenantId: string;
    userId: string;
    transactionId: string;
    input: ClassifyExpenseInput;
    meta?: RequestMeta;
  }): Promise<BankStatementDetailDto> {
    const { tenantId, transactionId, input } = args;
    const txRow = await this.findTransaction(tenantId, transactionId);
    if (txRow.status !== 'pending') throw this.notPending();
    if (txRow.amount >= 0) {
      throw new BadRequestException({
        code: 'not_a_debit',
        message: 'Solo un cargo (una salida de dinero) puede ser un gasto',
      });
    }
    const day = isoDate(txRow.operationDate ?? txRow.valueDate);
    if (!day) {
      throw new BadRequestException({
        code: 'transaction_without_date',
        message: 'El movimiento no tiene fecha: créalo a mano en Gastos',
      });
    }
    await this.claim(tenantId, transactionId, 'pending', { status: 'expense' });
    let expenseId: string;
    try {
      const description =
        input.description?.trim() || txRow.description?.trim() || 'Movimiento del banco';
      const expense = await this.expenses.create(tenantId, args.userId, {
        category: input.category,
        description: description.slice(0, 300),
        amount: Math.abs(txRow.amount) / 100,
        expenseDate: day,
        facilityId: input.facilityId ?? null,
        notes: 'Desde la conciliación bancaria',
      });
      expenseId = expense.id;
    } catch (err) {
      await this.prisma.withTenant(
        (tx) =>
          tx.bankStatementTransaction.updateMany({
            where: { id: transactionId, status: 'expense' },
            data: { status: 'pending' },
          }),
        tenantId,
      );
      throw err;
    }
    await this.updateTransaction(tenantId, transactionId, { expenseId });
    if (input.rememberPattern) {
      await this.rememberRule(tenantId, args.userId, {
        pattern: input.rememberPattern,
        kind: 'expense',
        expenseCategory: input.category,
      });
    }
    await this.countRuleHits(tenantId, 'expense', transactionText(txRow), {
      expenseCategory: input.category,
    });
    await this.audit.write({
      tenantId,
      userId: args.userId,
      action: 'bank_reconciliation.expense',
      entityType: 'BankStatementTransaction',
      entityId: transactionId,
      changes: { expenseId, category: input.category },
      ipAddress: args.meta?.ipAddress ?? null,
      userAgent: args.meta?.userAgent ?? null,
    });
    return this.getStatement(tenantId, txRow.statementId);
  }

  // ---------------------------------------------------------------- reglas

  async listRules(tenantId: string): Promise<BankMatchRuleDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.bankMatchRule.findMany({
          where: { tenantId },
          include: {
            customer: {
              select: { customerType: true, firstName: true, lastName: true, companyName: true },
            },
          },
          orderBy: [{ hits: 'desc' }, { createdAt: 'desc' }],
        }),
      tenantId,
    );
    return rows.map((r) => ({
      id: r.id,
      pattern: r.pattern,
      kind: r.kind as BankMatchRuleKind,
      customerId: r.customerId,
      customerName: r.customer ? customerName(r.customer) : null,
      expenseCategory: r.expenseCategory,
      hits: r.hits,
      lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async createRule(
    tenantId: string,
    userId: string,
    input: CreateBankMatchRuleInput,
  ): Promise<BankMatchRuleDto[]> {
    if (input.customerId) {
      const exists = await this.prisma.withTenant(
        (tx) => tx.customer.count({ where: { id: input.customerId!, tenantId, deletedAt: null } }),
        tenantId,
      );
      if (!exists) {
        throw new NotFoundException({
          code: 'customer_not_found',
          message: 'Inquilino no encontrado',
        });
      }
    }
    await this.rememberRule(tenantId, userId, input);
    return this.listRules(tenantId);
  }

  async deleteRule(tenantId: string, id: string): Promise<void> {
    const { count } = await this.prisma.withTenant(
      (tx) => tx.bankMatchRule.deleteMany({ where: { id, tenantId } }),
      tenantId,
    );
    if (count === 0) {
      throw new NotFoundException({ code: 'rule_not_found', message: 'Regla no encontrada' });
    }
  }

  /** Guarda (o corrige) una regla: el patrón en mayúsculas y sin acentos. */
  private async rememberRule(
    tenantId: string,
    userId: string | null,
    rule: {
      pattern: string;
      kind: BankMatchRuleKind;
      customerId?: string | undefined;
      expenseCategory?: string | undefined;
    },
  ): Promise<void> {
    const pattern = normalizeBankText(rule.pattern);
    if (pattern.length < 3) {
      throw new BadRequestException({
        code: 'rule_pattern_too_short',
        message: 'El texto que identifica al ordenante tiene que tener al menos 3 letras',
      });
    }
    const data = {
      customerId: rule.kind === 'customer' ? (rule.customerId ?? null) : null,
      expenseCategory: rule.kind === 'expense' ? (rule.expenseCategory ?? 'other') : null,
    };
    await this.prisma.withTenant(
      (tx) =>
        tx.bankMatchRule.upsert({
          where: { tenantId_kind_pattern: { tenantId, kind: rule.kind, pattern } },
          create: { tenantId, kind: rule.kind, pattern, createdByUserId: userId, ...data },
          update: data,
        }),
      tenantId,
    );
  }

  /** Las reglas que acertaron con este movimiento suman un uso. */
  private async countRuleHits(
    tenantId: string,
    kind: BankMatchRuleKind,
    text: string,
    target: { customerId?: string; expenseCategory?: string },
  ): Promise<void> {
    const rules = await this.loadRules(tenantId);
    const ids = rules
      .filter(
        (r) =>
          r.kind === kind &&
          (kind === 'customer'
            ? r.customerId === target.customerId
            : r.expenseCategory === target.expenseCategory) &&
          bankTextContains(text, r.pattern),
      )
      .map((r) => r.id);
    if (ids.length === 0) return;
    await this.prisma.withTenant(
      (tx) =>
        tx.bankMatchRule.updateMany({
          where: { id: { in: ids } },
          data: { hits: { increment: 1 }, lastUsedAt: new Date() },
        }),
      tenantId,
    );
  }

  /** Marca un cargo como **devolución** de un cobro por banco: revierte ese cobro. */
  async markReturn(args: {
    tenantId: string;
    userId: string;
    transactionId: string;
    invoiceId: string;
    paymentId?: string;
    meta?: RequestMeta;
  }): Promise<BankStatementDetailDto> {
    const { tenantId, transactionId, invoiceId } = args;
    const txRow = await this.findTransaction(tenantId, transactionId);
    if (txRow.status !== 'pending') throw this.notPending();
    if (txRow.amount >= 0) {
      throw new BadRequestException({
        code: 'not_a_debit',
        message: 'Solo los cargos pueden marcarse como devolución',
      });
    }
    const charge = Math.abs(txRow.amount);
    // El cobro que se devuelve: uno que entró por el banco (transferencia o
    // domiciliación) y que sigue cobrado. Un cobro en efectivo o con tarjeta
    // no lo puede devolver el banco.
    const payment = await this.prisma.withTenant(
      (tx) =>
        tx.payment.findFirst({
          where: {
            invoiceId,
            tenantId,
            status: 'succeeded',
            gateway: 'manual',
            methodType: { in: [...BANK_METHODS] },
            ...(args.paymentId ? { id: args.paymentId } : { amount: charge / 100 }),
          },
          orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
          select: { id: true, amount: true, methodType: true },
        }),
      tenantId,
    );
    if (!payment) {
      throw new BadRequestException({
        code: 'nothing_to_revert',
        message: 'Esa factura no tiene un cobro por banco que se pueda devolver con este cargo.',
      });
    }
    // El banco devuelve el adeudo entero (y a veces cobra la comisión en el
    // mismo apunte): el cargo no puede ser menor que el cobro.
    if (charge < toCents(payment.amount)) {
      throw new BadRequestException({
        code: 'return_amount_mismatch',
        message: 'El cargo es menor que el cobro: no es la devolución de ese cobro.',
      });
    }
    await this.claim(tenantId, transactionId, 'pending', {
      status: 'returned',
      matchedInvoiceId: invoiceId,
      matchedAt: new Date(),
      matchedPaymentIds: [payment.id],
      matchedPaymentId: payment.id,
    });
    // El código de devolución (AM04, MD06…) si el banco lo pone en el concepto.
    const returnCode = findReturnCode(
      [txRow.description, txRow.conceptOwn, txRow.reference1, txRow.reference2]
        .filter(Boolean)
        .join(' '),
    );
    try {
      await this.invoices.revertPayment({
        tenantId,
        userId: args.userId,
        invoiceId,
        amount: Number(payment.amount),
        paymentId: payment.id,
        returnedAt: await this.movementInstant(tenantId, txRow),
        reason: returnCode
          ? `Devolución (conciliación N43): ${returnCodeLabel(returnCode)}`
          : 'Devolución (conciliación N43)',
        returnCode,
        meta: args.meta ?? {},
      });
    } catch (err) {
      await this.release(tenantId, transactionId, 'returned');
      throw err;
    }
    // Si era un adeudo de remesa, queda «devuelto»: la factura puede volver
    // a presentarse en otra remesa.
    if (payment.methodType === 'sepa_debit') {
      await this.prisma.withTenant(
        (tx) => markSepaItemReturned(tx, invoiceId, { returnCode }),
        tenantId,
      );
    }
    await this.audit.write({
      tenantId,
      userId: args.userId,
      action: 'bank_reconciliation.returned',
      entityType: 'BankStatementTransaction',
      entityId: transactionId,
      changes: { invoiceId, paymentId: payment.id, fee: (charge - toCents(payment.amount)) / 100 },
      ipAddress: args.meta?.ipAddress ?? null,
      userAgent: args.meta?.userAgent ?? null,
    });
    return this.getStatement(tenantId, txRow.statementId);
  }

  /** Revisado sin conciliar (un cargo del banco, un ingreso que no es de un inquilino). */
  async ignoreTransaction(args: {
    tenantId: string;
    userId: string;
    transactionId: string;
    meta?: RequestMeta;
  }): Promise<BankStatementDetailDto> {
    const txRow = await this.findTransaction(args.tenantId, args.transactionId);
    await this.claim(args.tenantId, args.transactionId, 'pending', { status: 'ignored' });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'bank_reconciliation.ignored',
      entityType: 'BankStatementTransaction',
      entityId: args.transactionId,
      changes: {},
      ipAddress: args.meta?.ipAddress ?? null,
      userAgent: args.meta?.userAgent ?? null,
    });
    return this.getStatement(args.tenantId, txRow.statementId);
  }

  /**
   * Deshace lo hecho con un apunte: una conciliación (anula sus cobros y, si
   * el sobrante fue a saldo a favor, lo retira), una devolución (el cobro vuelve
   * a contar) o un «ignorado». El apunte vuelve a pendiente.
   */
  async undoTransaction(args: {
    tenantId: string;
    userId: string;
    transactionId: string;
    meta?: RequestMeta;
  }): Promise<BankStatementDetailDto> {
    const { tenantId } = args;
    const t = await this.findTransaction(tenantId, args.transactionId);
    if (!this.canUndo(t)) {
      throw new BadRequestException({
        code: 'not_undoable',
        message:
          t.status === 'pending'
            ? 'Este movimiento está pendiente: no hay nada que deshacer.'
            : 'Este movimiento se concilió antes de que se pudiera deshacer: corrige el cobro desde la factura.',
      });
    }
    const paymentIds = t.matchedPaymentIds.length
      ? t.matchedPaymentIds
      : t.matchedPaymentId
        ? [t.matchedPaymentId]
        : [];
    const cleared: Prisma.BankStatementTransactionUncheckedUpdateManyInput = {
      status: 'pending',
      matchedInvoiceId: null,
      matchedAt: null,
      autoMatched: false,
      matchedPaymentId: null,
      matchedPaymentIds: [],
      unappliedAmount: 0,
      creditContractId: null,
      matchedRemittanceId: null,
      expenseId: null,
    };

    if (t.status === 'ignored') {
      await this.claim(tenantId, t.id, 'ignored', cleared);
    } else if (t.status === 'expense') {
      // El gasto que se creó se borra (si sigue).
      await this.claim(tenantId, t.id, 'expense', cleared);
      if (t.expenseId) {
        await this.expenses.remove(tenantId, t.expenseId).catch(() => undefined);
      }
    } else if (t.status === 'matched' && t.matchedRemittanceId) {
      // Solo se quita el enlace: la remesa sigue registrada.
      await this.claim(tenantId, t.id, 'matched', cleared);
    } else if (t.status === 'matched') {
      // El saldo a favor que dejó: si ya se usó en otra factura, no se puede
      // retirar solo (hay que corregirlo a mano).
      if (t.creditContractId && t.unappliedAmount > 0) {
        const contract = await this.prisma.withTenant(
          (tx) =>
            tx.contract.findUnique({
              where: { id: t.creditContractId! },
              select: { creditBalance: true },
            }),
          tenantId,
        );
        if (!contract || toCents(contract.creditBalance) < t.unappliedAmount) {
          throw new ConflictException({
            code: 'surplus_credit_used',
            message:
              'El saldo a favor que dejó este ingreso ya se ha descontado de otra factura: deshazlo a mano.',
          });
        }
      }
      await this.claim(tenantId, t.id, 'matched', cleared);
      const reverted: string[] = [];
      try {
        for (const paymentId of paymentIds) {
          const p = await this.prisma.withTenant(
            (tx) =>
              tx.payment.findUnique({
                where: { id: paymentId },
                select: { invoiceId: true, amount: true, status: true },
              }),
            tenantId,
          );
          // Ya deshecho por otro lado: nada que revertir.
          if (!p?.invoiceId || p.status !== 'succeeded') {
            reverted.push(paymentId);
            continue;
          }
          await this.invoices.revertPayment({
            tenantId,
            userId: args.userId,
            invoiceId: p.invoiceId,
            amount: Number(p.amount),
            paymentId,
            undo: true,
            reason: 'Conciliación bancaria deshecha',
            meta: args.meta ?? {},
          });
          reverted.push(paymentId);
        }
      } catch (err) {
        // Lo que no se pudo deshacer sigue conciliado.
        const left = paymentIds.filter((id) => !reverted.includes(id));
        await this.updateTransaction(tenantId, t.id, {
          status: 'matched',
          matchedInvoiceId: t.matchedInvoiceId,
          matchedAt: t.matchedAt,
          autoMatched: t.autoMatched,
          matchedPaymentIds: left,
          matchedPaymentId: left[0] ?? null,
          unappliedAmount: t.unappliedAmount,
          creditContractId: t.creditContractId,
        });
        throw err;
      }
      if (t.creditContractId && t.unappliedAmount > 0) {
        await this.prisma.withTenant(
          (tx) =>
            tx.contract.update({
              where: { id: t.creditContractId! },
              data: { creditBalance: { decrement: t.unappliedAmount / 100 } },
            }),
          tenantId,
        );
      }
    } else {
      // Devolución registrada por error: el cobro vuelve a contar.
      await this.claim(tenantId, t.id, 'returned', cleared);
      try {
        for (const paymentId of paymentIds) {
          const p = await this.prisma.withTenant(
            (tx) =>
              tx.payment.findUnique({
                where: { id: paymentId },
                select: { invoiceId: true, methodType: true },
              }),
            tenantId,
          );
          if (!p?.invoiceId) continue;
          await this.invoices.restorePayment({
            tenantId,
            userId: args.userId,
            invoiceId: p.invoiceId,
            paymentId,
            reason: 'Devolución deshecha en la conciliación bancaria',
            meta: args.meta ?? {},
          });
          if (p.methodType === 'sepa_debit') {
            await this.prisma.withTenant(
              (tx) => markSepaItemCollectedAgain(tx, p.invoiceId!),
              tenantId,
            );
          }
        }
      } catch (err) {
        await this.updateTransaction(tenantId, t.id, {
          status: 'returned',
          matchedInvoiceId: t.matchedInvoiceId,
          matchedAt: t.matchedAt,
          matchedPaymentIds: paymentIds,
          matchedPaymentId: paymentIds[0] ?? null,
        });
        throw err;
      }
    }
    await this.audit.write({
      tenantId,
      userId: args.userId,
      action: 'bank_reconciliation.undone',
      entityType: 'BankStatementTransaction',
      entityId: t.id,
      changes: { status: t.status, paymentIds },
      ipAddress: args.meta?.ipAddress ?? null,
      userAgent: args.meta?.userAgent ?? null,
    });
    return this.getStatement(tenantId, t.statementId);
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
          orderBy: [{ operationDate: 'asc' }, { id: 'asc' }],
        }),
      tenantId,
    );
    if (txs.length === 0) return 0;
    // Solo facturas sin un cobro en marcha: una en una remesa SEPA sin
    // confirmar o con un cobro por pasarela en curso se concilia a mano (si
    // no, la remesa la daría luego por «ya pagada» y habría que devolverla).
    const candidates = (await this.loadCandidates(tenantId)).filter((c) => !c.inFlight);
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
      let paymentId: string;
      try {
        ({ paymentId } = await this.invoices.registerManualPayment({
          tenantId,
          userId,
          invoiceId: invoice.id,
          input: {
            amount: t.amount / 100,
            paidAt: (await this.movementInstant(tenantId, t)).toISOString(),
            methodType: 'bank_transfer',
            notes: 'Conciliación N43 automática',
            overridePaymentInFlight: true,
            allowInSepaRemittance: true,
            allowPartialNonCash: true,
          },
          meta: {},
        }));
      } catch (err) {
        this.logger.warn(
          `[bank] conciliación automática fallida (${t.id}): ${err instanceof Error ? err.message : String(err)}`,
        );
        await this.release(tenantId, t.id, 'matched');
        continue;
      }
      try {
        await this.updateTransaction(tenantId, t.id, {
          matchedPaymentId: paymentId,
          matchedPaymentIds: [paymentId],
        });
      } catch (err) {
        // El cobro ya está hecho: solo falta el enlace (se ve en la factura).
        this.logger.warn(
          `[bank] no se pudo enlazar el cobro ${paymentId} al apunte ${t.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      matched += 1;
    }
    return matched;
  }

  // -------------------------------------------------------------------------

  private async findTransaction(tenantId: string, transactionId: string): Promise<TransactionRow> {
    const row = await this.prisma.withTenant(
      (tx) => tx.bankStatementTransaction.findFirst({ where: { id: transactionId, tenantId } }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'transaction_not_found',
        message: 'Movimiento no encontrado',
      });
    }
    return row;
  }

  private statementNotFound(): NotFoundException {
    return new NotFoundException({
      code: 'statement_not_found',
      message: 'Extracto no encontrado',
    });
  }

  private notPending(): BadRequestException {
    return new BadRequestException({
      code: 'already_matched',
      message: 'El movimiento ya está conciliado, devuelto o ignorado',
    });
  }

  /**
   * Cambia el apunte de estado de forma atómica (`from` → lo indicado). Si otro
   * proceso ya lo cambió, 400 `already_matched`.
   */
  private async claim(
    tenantId: string,
    transactionId: string,
    from: string,
    data: Prisma.BankStatementTransactionUncheckedUpdateManyInput,
  ): Promise<void> {
    const { count } = await this.prisma.withTenant(
      (tx) =>
        tx.bankStatementTransaction.updateMany({
          where: { id: transactionId, status: from },
          data,
        }),
      tenantId,
    );
    if (count === 0) throw this.notPending();
  }

  /** Deshace la reclamación si el cobro o la devolución fallaron. */
  private async release(
    tenantId: string,
    transactionId: string,
    status: 'matched' | 'returned',
  ): Promise<void> {
    await this.prisma.withTenant(
      (tx) =>
        tx.bankStatementTransaction.updateMany({
          where: { id: transactionId, status },
          data: {
            status: 'pending',
            matchedInvoiceId: null,
            matchedAt: null,
            autoMatched: false,
            matchedPaymentId: null,
            matchedPaymentIds: [],
          },
        }),
      tenantId,
    );
  }

  private async updateTransaction(
    tenantId: string,
    transactionId: string,
    data: Prisma.BankStatementTransactionUncheckedUpdateInput,
  ): Promise<void> {
    await this.prisma.withTenant(
      (tx) => tx.bankStatementTransaction.update({ where: { id: transactionId }, data }),
      tenantId,
    );
  }

  /**
   * Cuándo entró (o salió) el dinero: el día del apunte en el banco (fecha de
   * operación, o la valor si no la trae), a mediodía en la zona del negocio.
   * Nunca en el futuro.
   */
  private async movementInstant(
    tenantId: string,
    t: { operationDate: Date | null; valueDate: Date | null },
  ): Promise<Date> {
    const day = isoDate(t.operationDate ?? t.valueDate);
    if (!day) return new Date();
    const tenant = await this.prisma.withTenant(
      (tx) => tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }),
      tenantId,
    );
    const start = zonedDayStart(day, tenant?.timezone ?? 'Europe/Madrid');
    if (Number.isNaN(start.getTime())) return new Date();
    const noon = new Date(start.getTime() + 12 * 3_600_000);
    return noon.getTime() > Date.now() ? new Date() : noon;
  }

  private async loadCandidates(tenantId: string): Promise<CandidateInvoice[]> {
    const invoices = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findMany({
          where: { tenantId, status: { in: ['issued', 'overdue'] }, deletedAt: null },
          // La más antigua primero (para repartir y sumar).
          orderBy: [{ dueDate: 'asc' }, { issueDate: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            invoiceNumber: true,
            customerId: true,
            total: true,
            amountPaid: true,
            customer: {
              select: { customerType: true, firstName: true, lastName: true, companyName: true },
            },
            sepaRemittanceItems: { where: { status: 'pending' }, select: { id: true } },
            payments: {
              where: { status: { in: ['pending', 'processing'] } },
              select: { id: true },
            },
          },
        }),
      tenantId,
    );
    return invoices
      .map((inv) => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        customerId: inv.customerId,
        customerName: customerName(inv.customer),
        amountPendingCents: toCents(inv.total) - toCents(inv.amountPaid),
        inFlight: inv.sepaRemittanceItems.length > 0 || inv.payments.length > 0,
      }))
      .filter((c) => c.amountPendingCents > 0);
  }

  /**
   * Sugiere facturas para un abono. Primero las de importe exacto (el número
   * de factura en el concepto, una regla aprendida o el nombre del ordenante
   * desempatan); después, varias facturas del mismo inquilino que suman justo
   * el ingreso (del ordenante o de una regla, o de cualquiera si no hay más).
   */
  private suggest(
    amountCents: number,
    tx: {
      reference1: string | null;
      reference2: string | null;
      documentNumber: string | null;
      description: string | null;
      conceptOwn: string | null;
    },
    candidates: CandidateInvoice[],
    rules: RuleRow[] = [],
  ): BankTransactionSuggestionDto[] {
    const haystack = [tx.reference1, tx.reference2, tx.documentNumber, tx.description]
      .filter(Boolean)
      .join(' ');
    const text = transactionText(tx);
    const ruleCustomers = new Set(
      rules
        .filter((r) => r.kind === 'customer' && r.customerId && bankTextContains(text, r.pattern))
        .map((r) => r.customerId!),
    );
    const payerCustomers = new Set(
      candidates
        .filter((c) => c.customerId && nameMatches(text, c.customerName))
        .map((c) => c.customerId!),
    );
    const reasonOf = (c: CandidateInvoice): NonNullable<BankTransactionSuggestionDto['reason']> =>
      containsInvoiceNumber(haystack, c.invoiceNumber)
        ? 'reference'
        : c.customerId && ruleCustomers.has(c.customerId)
          ? 'rule'
          : c.customerId && payerCustomers.has(c.customerId)
            ? 'payer'
            : 'amount';
    const rank = { reference: 0, rule: 1, payer: 2, amount: 3, sum: 4 } as const;
    const warning =
      'Tiene un cobro en curso (remesa SEPA o pasarela): si concilias este ingreso, quítala de la remesa o se cobrará dos veces.';

    const out: BankTransactionSuggestionDto[] = candidates
      .filter((c) => c.amountPendingCents === amountCents)
      .map((c) => ({ c, reason: reasonOf(c) }))
      .sort((a, b) => rank[a.reason] - rank[b.reason])
      .slice(0, 3)
      .map(({ c, reason }) => ({
        invoiceId: c.id,
        invoiceNumber: c.invoiceNumber,
        customerName: c.customerName,
        amountPending: c.amountPendingCents / 100,
        reason,
        ...(c.inFlight ? { warning } : {}),
      }));

    // Varias facturas del mismo inquilino que suman el ingreso.
    const byCustomer = new Map<string, CandidateInvoice[]>();
    for (const c of candidates) {
      if (!c.customerId) continue;
      byCustomer.set(c.customerId, [...(byCustomer.get(c.customerId) ?? []), c]);
    }
    const known = [...ruleCustomers, ...payerCustomers];
    const pool = out.length > 0 || known.length > 0 ? known : [...byCustomer.keys()];
    for (const customerId of new Set(pool)) {
      if (out.length >= 4) break;
      const list = byCustomer.get(customerId) ?? [];
      const ids = findInvoiceSubset(
        list.map((c) => ({ id: c.id, cents: c.amountPendingCents })),
        amountCents,
      );
      if (!ids) continue;
      const picked = ids.map((id) => list.find((c) => c.id === id)!);
      out.push({
        invoiceId: picked[0]!.id,
        invoiceNumber: picked[0]!.invoiceNumber,
        customerName: picked[0]!.customerName,
        amountPending: amountCents / 100,
        invoiceIds: ids,
        invoiceNumbers: picked.map((c) => c.invoiceNumber),
        reason: 'sum',
        ...(picked.some((c) => c.inFlight) ? { warning } : {}),
      });
    }
    return out.slice(0, 4);
  }

  /** Remesas cuyo abono es este ingreso (mismo importe, unos días alrededor del cargo). */
  private suggestRemittances(
    t: { amount: number; operationDate: Date | null; valueDate: Date | null },
    remittances: RemittanceCandidate[],
  ): BankRemittanceSuggestionDto[] {
    const when = t.valueDate ?? t.operationDate;
    return remittances
      .filter(
        (r) => r.expectedCents === t.amount && (!when || daysApart(when, r.collectionDate) <= 10),
      )
      .slice(0, 2)
      .map((r) => ({
        remittanceId: r.id,
        name: r.name,
        amount: r.expectedCents / 100,
        collectionDate: r.collectionDate.toISOString().slice(0, 10),
        status: r.status,
      }));
  }

  private remittanceAlreadyMatched(): ConflictException {
    return new ConflictException({
      code: 'remittance_already_matched',
      message: 'El abono de esa remesa ya está conciliado con otro ingreso.',
    });
  }

  /**
   * Remesas que aún no tienen su abono conciliado; con `remittanceId`, esa
   * remesa (y si ya lo tiene, `matched`).
   */
  private async loadRemittanceCandidates(
    tenantId: string,
    remittanceId?: string,
    opts: { includeMatched?: boolean } = {},
  ): Promise<RemittanceCandidate[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.sepaRemittance.findMany({
          where: {
            tenantId,
            ...(remittanceId ? { id: remittanceId } : {}),
            status: { in: ['generated', 'confirmed'] },
            ...(opts.includeMatched ? {} : { bankTransactions: { none: { status: 'matched' } } }),
          },
          select: {
            id: true,
            name: true,
            status: true,
            collectionDate: true,
            items: {
              where: { status: { in: ['pending', 'collected'] } },
              select: { amount: true },
            },
            _count: { select: { bankTransactions: { where: { status: 'matched' } } } },
          },
          orderBy: { collectionDate: 'desc' },
          take: 100,
        }),
      tenantId,
    );
    return rows
      .map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status as RemittanceCandidate['status'],
        collectionDate: r.collectionDate,
        expectedCents: r.items.reduce((sum, i) => sum + i.amount, 0),
        matched: r._count.bankTransactions > 0,
      }))
      .filter((r) => r.expectedCents > 0);
  }

  private async loadRules(tenantId: string): Promise<RuleRow[]> {
    return this.prisma.withTenant(
      (tx) =>
        tx.bankMatchRule.findMany({
          where: { tenantId },
          select: { id: true, pattern: true, kind: true, customerId: true, expenseCategory: true },
        }),
      tenantId,
    );
  }

  /** Cobros por banco aún cobrados (candidatos a una devolución en un cargo). */
  private async loadReturnCandidates(tenantId: string): Promise<ReturnCandidate[]> {
    const since = new Date(Date.now() - RETURN_LOOKBACK_DAYS * 86_400_000);
    const payments = await this.prisma.withTenant(
      (tx) =>
        tx.payment.findMany({
          where: {
            tenantId,
            status: 'succeeded',
            gateway: 'manual',
            methodType: { in: [...BANK_METHODS] },
            paidAt: { gte: since },
            invoice: { deletedAt: null },
          },
          select: {
            id: true,
            amount: true,
            paidAt: true,
            methodType: true,
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
                  },
                },
              },
            },
          },
          orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
          take: 2000,
        }),
      tenantId,
    );
    return payments
      .filter((p) => !!p.invoice)
      .map((p) => ({
        paymentId: p.id,
        invoiceId: p.invoice!.id,
        invoiceNumber: p.invoice!.invoiceNumber,
        customerName: customerName(p.invoice!.customer),
        amountCents: toCents(p.amount),
        paidAt: p.paidAt,
        methodType: p.methodType,
      }));
  }

  /**
   * Sugiere cobros por banco de ese importe (una devolución de adeudo puede
   * llevar además la comisión del banco en el mismo apunte: entonces casa por
   * referencia). Primero los domiciliados, que son los que se devuelven.
   */
  private suggestReturns(
    amountCents: number,
    tx: {
      reference1: string | null;
      reference2: string | null;
      documentNumber: string | null;
      description: string | null;
    },
    candidates: ReturnCandidate[],
  ): BankTransactionSuggestionDto[] {
    const haystack = [tx.reference1, tx.reference2, tx.documentNumber, tx.description]
      .filter(Boolean)
      .join(' ');
    return candidates
      .map((c) => ({ c, refMatch: containsInvoiceNumber(haystack, c.invoiceNumber) }))
      .filter(
        ({ c, refMatch }) =>
          c.amountCents === amountCents || (refMatch && c.amountCents < amountCents),
      )
      .sort(
        (a, b) =>
          Number(b.refMatch) - Number(a.refMatch) ||
          Number(b.c.methodType === 'sepa_debit') - Number(a.c.methodType === 'sepa_debit'),
      )
      .slice(0, 3)
      .map(({ c }) => ({
        invoiceId: c.invoiceId,
        invoiceNumber: c.invoiceNumber,
        customerName: c.customerName,
        amountPending: c.amountCents / 100,
        paymentId: c.paymentId,
        paidAt: c.paidAt ? c.paidAt.toISOString() : null,
        methodType: c.methodType,
      }));
  }

  /** Facturas de los cobros (o del cobro devuelto) de cada apunte. */
  private async linkedInvoices(
    tenantId: string,
    rows: TransactionRow[],
  ): Promise<Map<string, { id: string; invoiceNumber: string }[]>> {
    const paymentIds = [
      ...new Set(
        rows.flatMap((r) =>
          r.matchedPaymentIds.length
            ? r.matchedPaymentIds
            : r.matchedPaymentId
              ? [r.matchedPaymentId]
              : [],
        ),
      ),
    ];
    const invoiceIds = [
      ...new Set(rows.map((r) => r.matchedInvoiceId).filter((x): x is string => !!x)),
    ];
    const [payments, invoices] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          paymentIds.length
            ? tx.payment.findMany({
                where: { id: { in: paymentIds } },
                select: { id: true, invoice: { select: { id: true, invoiceNumber: true } } },
              })
            : Promise.resolve([]),
          invoiceIds.length
            ? tx.invoice.findMany({
                where: { tenantId, id: { in: invoiceIds } },
                select: { id: true, invoiceNumber: true },
              })
            : Promise.resolve([]),
        ]),
      tenantId,
    );
    const byPayment = new Map(payments.map((p) => [p.id, p.invoice]));
    const out = new Map<string, { id: string; invoiceNumber: string }[]>();
    for (const r of rows) {
      const ids = r.matchedPaymentIds.length
        ? r.matchedPaymentIds
        : r.matchedPaymentId
          ? [r.matchedPaymentId]
          : [];
      const list = ids
        .map((id) => byPayment.get(id))
        .filter((i): i is { id: string; invoiceNumber: string } => !!i);
      if (list.length === 0 && r.matchedInvoiceId) {
        const inv = invoices.find((i) => i.id === r.matchedInvoiceId);
        if (inv) list.push(inv);
      }
      out.set(
        r.id,
        list.filter((i, idx) => list.findIndex((x) => x.id === i.id) === idx),
      );
    }
    return out;
  }

  private toDto(
    s: {
      id: string;
      source: string;
      filename: string;
      accountLabel: string;
      currency: string;
      startDate: Date | null;
      endDate: Date | null;
      initialBalance: number;
      finalBalance: number;
      warnings: string[];
      transactionCount: number;
      createdAt: Date;
    },
    matchedCount: number,
    pendingCount: number,
  ): BankStatementDto {
    return {
      id: s.id,
      source: s.source === 'csv' ? 'csv' : 'n43',
      filename: s.filename,
      accountLabel: s.accountLabel,
      currency: s.currency,
      startDate: isoDate(s.startDate),
      endDate: isoDate(s.endDate),
      initialBalance: s.initialBalance / 100,
      finalBalance: s.finalBalance / 100,
      transactionCount: s.transactionCount,
      matchedCount,
      pendingCount,
      warnings: s.warnings,
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
