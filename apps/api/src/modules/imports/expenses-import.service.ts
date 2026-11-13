import { Injectable } from '@nestjs/common';
import {
  CreateExpenseSchema,
  EXPENSE_CATEGORY_LABELS,
  EXPENSE_PAYMENT_METHOD_LABELS,
  ExpenseCategoryEnum,
  ExpensePaymentMethodEnum,
  expenseAmounts,
  type ExpensePaymentMethod,
  type ImportCommitDto,
  type ImportDuplicatePolicy,
  type ImportPreviewDto,
} from '@storageos/shared';
import Papa from 'papaparse';

import { PrismaService } from '../database/prisma.service';
import { ExpensesService } from '../expenses/expenses.service';

import {
  buildPreview,
  facilitiesByName,
  flattenZodErrors,
  normalizeDate,
  parseDecimal,
  parseRaw,
  resolveColumns,
  runCommit,
  type RowEval,
  type RowEvaluator,
} from './import-engine';

type ExpenseField =
  | 'expenseDate'
  | 'description'
  | 'amount'
  | 'baseAmount'
  | 'vatRate'
  | 'withholdingRate'
  | 'withholdingModel'
  | 'category'
  | 'facility'
  | 'vendor'
  | 'vendorTaxId'
  | 'invoiceNumber'
  | 'paid'
  | 'paymentMethod'
  | 'dueDate'
  | 'notes';

const ALIASES: Record<string, ExpenseField> = {
  expensedate: 'expenseDate',
  fecha: 'expenseDate',
  fechafactura: 'expenseDate',
  date: 'expenseDate',
  description: 'description',
  descripcion: 'description',
  concepto: 'description',
  amount: 'amount',
  importe: 'amount',
  total: 'amount',
  totalfactura: 'amount',
  baseamount: 'baseAmount',
  base: 'baseAmount',
  baseimponible: 'baseAmount',
  vatrate: 'vatRate',
  iva: 'vatRate',
  tipoiva: 'vatRate',
  withholdingrate: 'withholdingRate',
  retencion: 'withholdingRate',
  irpf: 'withholdingRate',
  withholdingmodel: 'withholdingModel',
  modelo: 'withholdingModel',
  category: 'category',
  categoria: 'category',
  facility: 'facility',
  local: 'facility',
  vendor: 'vendor',
  proveedor: 'vendor',
  vendortaxid: 'vendorTaxId',
  nif: 'vendorTaxId',
  cif: 'vendorTaxId',
  nifproveedor: 'vendorTaxId',
  invoicenumber: 'invoiceNumber',
  factura: 'invoiceNumber',
  numerofactura: 'invoiceNumber',
  nfactura: 'invoiceNumber',
  paid: 'paid',
  pagado: 'paid',
  paymentmethod: 'paymentMethod',
  formapago: 'paymentMethod',
  formadepago: 'paymentMethod',
  duedate: 'dueDate',
  vencimiento: 'dueDate',
  vence: 'dueDate',
  notes: 'notes',
  notas: 'notes',
};

const TEMPLATE_HEADERS = [
  'fecha',
  'concepto',
  'importe',
  'base',
  'iva',
  'retencion',
  'modelo',
  'categoria',
  'local',
  'proveedor',
  'nif',
  'factura',
  'pagado',
  'forma de pago',
  'vencimiento',
  'notas',
] as const;

const YES = new Set(['si', 'sí', 's', 'yes', 'y', 'true', '1', 'x', 'pagado']);
const NO = new Set(['no', 'n', 'false', '0', 'pendiente']);

const fold = (v: string): string => v.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

interface ExpensesCtx {
  tenantId: string;
  categories: Map<string, string>;
  facilities: { byName: Map<string, string>; ambiguous: Set<string> };
  suppliers: Map<string, string>;
  /** Huella de los gastos que ya hay: fecha|importe|concepto y nif|factura. */
  existing: Set<string>;
}

/**
 * Importación de gastos desde CSV o Excel (p. ej. el libro de gastos del
 * programa anterior o del asesor). Con base, IVA y retención se desglosan; si
 * no, el importe. Un gasto con la misma fecha, importe y concepto, o el mismo
 * NIF y número de factura, cuenta como repetido. No se apunta nada en la caja:
 * son gastos de días pasados.
 */
@Injectable()
export class ExpensesImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly expenses: ExpensesService,
  ) {}

  template(): string {
    const example: Record<string, string> = {
      fecha: '05/10/2026',
      concepto: 'Luz del local',
      importe: '',
      base: '100,00',
      iva: '21',
      retencion: '0',
      modelo: '',
      categoria: 'Suministros',
      local: '',
      proveedor: 'Eléctrica Ejemplo SA',
      nif: 'A12345674',
      factura: 'E-2026-1234',
      pagado: 'sí',
      'forma de pago': 'Domiciliación',
      vencimiento: '',
      notas: '',
    };
    return Papa.unparse({
      fields: [...TEMPLATE_HEADERS],
      data: [TEMPLATE_HEADERS.map((h) => example[h] ?? '')],
    });
  }

  async preview(tenantId: string, csv: string): Promise<ImportPreviewDto> {
    const { columns, records } = parseRaw(csv);
    const ctx = await this.prepare(tenantId);
    return buildPreview(columns, records, this.makeEvaluator(columns, ctx, null));
  }

  async commit(args: {
    tenantId: string;
    userId: string;
    csv: string;
    onDuplicate: ImportDuplicatePolicy;
  }): Promise<ImportCommitDto> {
    const { columns, records } = parseRaw(args.csv);
    const ctx = await this.prepare(args.tenantId);
    return runCommit(records, this.makeEvaluator(columns, ctx, args.userId), args.onDuplicate);
  }

  private async prepare(tenantId: string): Promise<ExpensesCtx> {
    const [custom, facilities, suppliers, existing] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.expenseCategory.findMany({ select: { id: true, name: true } }),
          tx.facility.findMany({ where: { deletedAt: null }, select: { id: true, name: true } }),
          tx.expenseSupplier.findMany({ select: { id: true, name: true, taxId: true } }),
          tx.expense.findMany({
            select: {
              expenseDate: true,
              amount: true,
              description: true,
              vendorTaxId: true,
              invoiceNumber: true,
            },
          }),
        ]),
      tenantId,
    );
    const categories = new Map<string, string>();
    for (const key of ExpenseCategoryEnum.options) {
      categories.set(fold(key), key);
      categories.set(fold(EXPENSE_CATEGORY_LABELS[key]), key);
    }
    for (const c of custom) categories.set(fold(c.name), `custom:${c.id}`);
    const supplierMap = new Map<string, string>();
    for (const s of suppliers) {
      if (s.taxId) supplierMap.set(`nif:${s.taxId.toUpperCase()}`, s.id);
      supplierMap.set(`name:${fold(s.name)}`, s.id);
    }
    const fingerprints = new Set<string>();
    for (const e of existing) {
      fingerprints.add(
        this.fingerprint(e.expenseDate.toISOString().slice(0, 10), Number(e.amount), e.description),
      );
      if (e.vendorTaxId && e.invoiceNumber) {
        fingerprints.add(`inv:${e.vendorTaxId.toUpperCase()}|${fold(e.invoiceNumber)}`);
      }
    }
    return {
      tenantId,
      categories,
      facilities: facilitiesByName(facilities),
      suppliers: supplierMap,
      existing: fingerprints,
    };
  }

  private fingerprint(date: string, amount: number, description: string): string {
    return `row:${date}|${amount.toFixed(2)}|${fold(description)}`;
  }

  private makeEvaluator(columns: string[], ctx: ExpensesCtx, userId: string | null): RowEvaluator {
    const fieldByColumn = resolveColumns(columns, ALIASES);
    const seen = new Set<string>();
    const methodByLabel = new Map<string, ExpensePaymentMethod>();
    for (const m of ExpensePaymentMethodEnum.options) {
      methodByLabel.set(fold(m), m);
      methodByLabel.set(fold(EXPENSE_PAYMENT_METHOD_LABELS[m]), m);
    }
    methodByLabel.set('domiciliacion bancaria', 'direct_debit');
    methodByLabel.set('recibo', 'direct_debit');

    return (raw): RowEval => {
      const get = (field: ExpenseField): string => {
        for (const [col, f] of fieldByColumn) if (f === field) return (raw[col] ?? '').trim();
        return '';
      };
      const errors: string[] = [];

      const categoryText = get('category');
      const category = categoryText ? ctx.categories.get(fold(categoryText)) : 'other';
      if (!category)
        errors.push(`categoria: «${categoryText}» no existe (créala antes o déjala vacía)`);

      const facilityText = get('facility');
      let facilityId: string | null = null;
      if (facilityText) {
        const key = facilityText.toLowerCase();
        if (ctx.facilities.ambiguous.has(key)) errors.push(`local: hay varios «${facilityText}»`);
        else facilityId = ctx.facilities.byName.get(key) ?? null;
        if (!facilityId && !ctx.facilities.ambiguous.has(key)) {
          errors.push(`local: «${facilityText}» no existe`);
        }
      }

      const base = parseDecimal(get('baseAmount'));
      const amount = parseDecimal(get('amount'));
      const vatRate = parseDecimal(get('vatRate'));
      const withholdingRate = parseDecimal(get('withholdingRate'));
      const modelText = get('withholdingModel');
      const withholdingModel =
        modelText === '111' || modelText === '115'
          ? modelText
          : withholdingRate && withholdingRate > 0
            ? category === 'rent'
              ? '115'
              : '111'
            : null;

      const paidText = fold(get('paid'));
      const paid = paidText ? !NO.has(paidText) : true;
      if (paidText && !YES.has(paidText) && !NO.has(paidText)) {
        errors.push('pagado: escribe sí o no');
      }
      const methodText = get('paymentMethod');
      const paymentMethod = methodText ? methodByLabel.get(fold(methodText)) : undefined;
      if (methodText && !paymentMethod)
        errors.push(`forma de pago: «${methodText}» no se reconoce`);

      const vendorTaxId = get('vendorTaxId')
        .replace(/[\s.-]/g, '')
        .toUpperCase();
      const vendor = get('vendor');
      const supplierId =
        (vendorTaxId && ctx.suppliers.get(`nif:${vendorTaxId}`)) ||
        (vendor && ctx.suppliers.get(`name:${fold(vendor)}`)) ||
        null;

      const expenseDate = normalizeDate(get('expenseDate'));
      const dueDate = normalizeDate(get('dueDate'));
      const parsed = CreateExpenseSchema.safeParse({
        category: category ?? 'other',
        description: get('description'),
        expenseDate,
        ...(facilityId ? { facilityId } : {}),
        ...(base !== null
          ? {
              baseAmount: base,
              vatRate: vatRate ?? 0,
              withholdingRate: withholdingRate ?? 0,
              ...(withholdingModel ? { withholdingModel } : {}),
            }
          : amount !== null
            ? { amount }
            : {}),
        ...(vendor ? { vendor } : {}),
        ...(vendorTaxId ? { vendorTaxId } : {}),
        ...(supplierId ? { supplierId } : {}),
        ...(get('invoiceNumber') ? { invoiceNumber: get('invoiceNumber') } : {}),
        paymentStatus: paid ? 'paid' : 'pending',
        ...(paymentMethod ? { paymentMethod } : {}),
        ...(paid ? { paidAt: expenseDate } : {}),
        ...(!paid && dueDate ? { dueDate } : {}),
        ...(get('notes') ? { notes: get('notes') } : {}),
      });
      if (!parsed.success) errors.push(...flattenZodErrors(parsed.error));
      if (errors.length || !parsed.success) return { status: 'error', errors };

      const cost = expenseAmounts(parsed.data).amount;
      const keys = [this.fingerprint(parsed.data.expenseDate, cost, parsed.data.description)];
      if (vendorTaxId && parsed.data.invoiceNumber) {
        keys.push(`inv:${vendorTaxId}|${fold(parsed.data.invoiceNumber)}`);
      }
      const duplicate = keys.some((k) => ctx.existing.has(k) || seen.has(k));
      for (const k of keys) seen.add(k);
      const input = parsed.data;
      return {
        status: duplicate ? 'duplicate' : 'valid',
        errors: duplicate
          ? ['Ya hay un gasto igual (misma fecha, importe y concepto, o misma factura)']
          : [],
        create: async () => {
          const created = await this.expenses.create(ctx.tenantId, userId, input, null, {
            skipCash: true,
          });
          return created.id;
        },
      };
    };
  }
}
