import { z } from 'zod';

export * from './amounts';
export * from './recurrence';

export const ExpenseCategoryEnum = z.enum([
  'rent', // alquiler del local
  'utilities', // suministros (luz, agua, internet)
  'staff', // personal
  'maintenance', // mantenimiento y reparaciones
  'marketing', // publicidad
  'insurance', // seguros
  'supplies', // material y consumibles
  'taxes', // impuestos y tasas
  'other',
]);
export type ExpenseCategory = z.infer<typeof ExpenseCategoryEnum>;

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  rent: 'Alquiler',
  utilities: 'Suministros',
  staff: 'Personal',
  maintenance: 'Mantenimiento',
  marketing: 'Marketing',
  insurance: 'Seguros',
  supplies: 'Material',
  taxes: 'Impuestos',
  other: 'Otros',
};

/** Las categorías propias de cada empresa van en el gasto como `custom:<id>`. */
export const CUSTOM_EXPENSE_CATEGORY_PREFIX = 'custom:';

export function isBuiltinExpenseCategory(key: string): key is ExpenseCategory {
  return ExpenseCategoryEnum.safeParse(key).success;
}

/** Nombre de una categoría (de las de siempre o propia). */
export function expenseCategoryLabel(
  key: string,
  custom: ReadonlyArray<{ id: string; name: string }> = [],
): string {
  if (isBuiltinExpenseCategory(key)) return EXPENSE_CATEGORY_LABELS[key];
  if (key.startsWith(CUSTOM_EXPENSE_CATEGORY_PREFIX)) {
    const id = key.slice(CUSTOM_EXPENSE_CATEGORY_PREFIX.length);
    return custom.find((c) => c.id === id)?.name ?? 'Categoría borrada';
  }
  return key;
}

/** Clave de categoría: una de las de siempre o `custom:<id>` (se comprueba en el servidor). */
const categoryKey = z.string().trim().min(1).max(60);

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD');

/** Importe máximo de un gasto (la columna admite 12 cifras con 2 decimales). */
export const EXPENSE_MAX_AMOUNT = 99_999_999.99;
const expenseAmount = z
  .number()
  .positive()
  .finite()
  .max(EXPENSE_MAX_AMOUNT, 'El importe es demasiado alto');
const rate = z.number().min(0).max(100);
const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(''));

/** De dónde sale un gasto: a mano, de una plantilla recurrente o de una plataforma de anuncios. */
export type ExpenseSource = 'manual' | 'recurring' | 'google_ads' | 'meta_ads';

export const EXPENSE_SOURCE_LABELS: Record<ExpenseSource, string> = {
  manual: 'A mano',
  recurring: 'Recurrente',
  google_ads: 'Google Ads',
  meta_ads: 'Meta Ads',
};

// --- Desglose fiscal, pago y justificante ---

/** Modelo en que se declara la retención: 111 (profesionales) o 115 (alquiler del local). */
export const ExpenseWithholdingModelEnum = z.enum(['111', '115']);
export type ExpenseWithholdingModel = z.infer<typeof ExpenseWithholdingModelEnum>;
export const EXPENSE_WITHHOLDING_MODEL_LABELS: Record<ExpenseWithholdingModel, string> = {
  '111': 'Modelo 111 (profesionales)',
  '115': 'Modelo 115 (alquiler del local)',
};

export const EXPENSE_VAT_RATE_OPTIONS = [21, 10, 4, 0] as const;
export const EXPENSE_WITHHOLDING_RATE_OPTIONS = [0, 7, 15, 19] as const;

export const ExpensePaymentStatusEnum = z.enum(['paid', 'pending']);
export type ExpensePaymentStatus = z.infer<typeof ExpensePaymentStatusEnum>;
export const EXPENSE_PAYMENT_STATUS_LABELS: Record<ExpensePaymentStatus, string> = {
  paid: 'Pagado',
  pending: 'Pendiente de pago',
};

export const ExpensePaymentMethodEnum = z.enum([
  'cash',
  'card',
  'bank_transfer',
  'direct_debit',
  'other',
]);
export type ExpensePaymentMethod = z.infer<typeof ExpensePaymentMethodEnum>;
export const EXPENSE_PAYMENT_METHOD_LABELS: Record<ExpensePaymentMethod, string> = {
  cash: 'Efectivo',
  card: 'Tarjeta',
  bank_transfer: 'Transferencia',
  direct_debit: 'Domiciliación',
  other: 'Otra',
};

/** Justificante del gasto: foto o PDF de la factura del proveedor. */
export const EXPENSE_RECEIPT_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg'] as const;
export const EXPENSE_RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

const ExpenseFieldsSchema = z.object({
  /** Local al que se imputa el gasto; null/ausente = gasto general de la empresa. */
  facilityId: z.string().uuid().nullish(),
  category: categoryKey.default('other'),
  description: z.string().trim().min(1).max(300),
  /** Importe sin desglosar. Con `baseAmount`, se calcula. */
  amount: expenseAmount.optional(),
  expenseDate: dateOnly,
  vendor: optionalText(200),
  notes: optionalText(2000),
  /** Canal de marketing al que se imputa (solo aplica con category='marketing'). */
  marketingChannelId: z.string().uuid().nullish(),
  supplierId: z.string().uuid().nullish(),
  vendorTaxId: optionalText(30),
  invoiceNumber: optionalText(60),
  /** Base imponible; null = sin desglosar. */
  baseAmount: expenseAmount.nullish(),
  vatRate: rate.nullish(),
  vatDeductible: z.boolean().optional(),
  withholdingRate: rate.nullish(),
  withholdingModel: ExpenseWithholdingModelEnum.nullish(),
  /** Justificante subido con `receipt-upload-url`; null lo quita. */
  receiptKey: z.string().max(300).nullish(),
  receiptName: z.string().trim().max(200).nullish(),
  receiptMime: z.enum(EXPENSE_RECEIPT_MIME_TYPES).nullish(),
  paymentStatus: ExpensePaymentStatusEnum.optional(),
  paidAt: dateOnly.nullish(),
  paymentMethod: ExpensePaymentMethodEnum.nullish(),
  dueDate: dateOnly.nullish(),
});

export const CreateExpenseSchema = ExpenseFieldsSchema.refine(
  (v) => v.amount !== undefined || (v.baseAmount !== undefined && v.baseAmount !== null),
  { message: 'Indica el importe o la base', path: ['amount'] },
);
export type CreateExpenseInput = z.infer<typeof CreateExpenseSchema>;

export const UpdateExpenseSchema = ExpenseFieldsSchema.partial();
export type UpdateExpenseInput = z.infer<typeof UpdateExpenseSchema>;

export const MarkExpensePaidSchema = z.object({
  paidAt: dateOnly,
  paymentMethod: ExpensePaymentMethodEnum,
});
export type MarkExpensePaidInput = z.infer<typeof MarkExpensePaidSchema>;

export interface ExpenseDto {
  id: string;
  facilityId: string | null;
  facilityName: string | null;
  /** Una de las de siempre o `custom:<id>`. */
  category: string;
  categoryLabel: string;
  description: string;
  /** Lo que cuesta: base + IVA no deducible (o el importe sin desglosar). */
  amount: number;
  expenseDate: string;
  vendor: string | null;
  notes: string | null;
  marketingChannelId: string | null;
  marketingChannelName: string | null;
  /** De dónde sale. Los de Google o Meta Ads se actualizan solos y no se editan a mano. */
  source: ExpenseSource;
  /** Plantilla recurrente que lo generó. */
  recurringExpenseId: string | null;
  supplierId: string | null;
  supplierName: string | null;
  vendorTaxId: string | null;
  invoiceNumber: string | null;
  /** true = con base, IVA y retención. */
  broken: boolean;
  baseAmount: number | null;
  vatRate: number | null;
  vatAmount: number | null;
  vatDeductible: boolean;
  withholdingRate: number | null;
  withholdingAmount: number | null;
  withholdingModel: ExpenseWithholdingModel | null;
  /** Lo que se paga al proveedor (base + IVA − retención, o el importe). */
  totalAmount: number;
  hasReceipt: boolean;
  receiptName: string | null;
  paymentStatus: ExpensePaymentStatus;
  paidAt: string | null;
  paymentMethod: ExpensePaymentMethod | null;
  dueDate: string | null;
  /** Pendiente con el vencimiento ya pasado. */
  overdue: boolean;
  /** Salida de caja apuntada al pagarlo en efectivo. */
  cashMovementId: string | null;
  /** Aviso al guardar (p. ej. la caja de ese día estaba cerrada y no se apuntó la salida). */
  cashNotice?: string | null;
  createdAt: string;
}

export interface ExpenseTotalDto {
  count: number;
  /** Suma de lo que cuestan. */
  amount: number;
  /** Lo pendiente de pagar (de lo filtrado). */
  pending: number;
}

// --- Justificante leído con IA ---
export const RequestExpenseReceiptUploadSchema = z.object({
  mimeType: z.enum(EXPENSE_RECEIPT_MIME_TYPES),
});
export interface ExpenseReceiptUploadDto {
  uploadUrl: string;
  key: string;
  expiresIn: number;
}

export const ReadExpenseReceiptSchema = z.object({ key: z.string().min(1).max(300) });

/** Lo que la IA lee del justificante (todo opcional: se revisa antes de guardar). */
export interface ExpenseReceiptReadDto {
  vendor: string | null;
  vendorTaxId: string | null;
  invoiceNumber: string | null;
  expenseDate: string | null;
  description: string | null;
  category: string | null;
  baseAmount: number | null;
  vatRate: number | null;
  withholdingRate: number | null;
  totalAmount: number | null;
  /** Proveedor de la ficha con ese NIF, si existe. */
  supplierId: string | null;
}

// --- Proveedores ---
export const CreateExpenseSupplierSchema = z.object({
  name: z.string().trim().min(1).max(200),
  taxId: optionalText(30),
  email: z.string().trim().email().max(200).optional().or(z.literal('')),
  phone: optionalText(30),
  defaultCategory: categoryKey.nullish(),
  defaultVatRate: rate.nullish(),
  defaultWithholdingRate: rate.nullish(),
  defaultWithholdingModel: ExpenseWithholdingModelEnum.nullish(),
  defaultPaymentMethod: ExpensePaymentMethodEnum.nullish(),
  notes: optionalText(1000),
  isActive: z.boolean().optional(),
});
export type CreateExpenseSupplierInput = z.infer<typeof CreateExpenseSupplierSchema>;
export const UpdateExpenseSupplierSchema = CreateExpenseSupplierSchema.partial();
export type UpdateExpenseSupplierInput = z.infer<typeof UpdateExpenseSupplierSchema>;

export interface ExpenseSupplierDto {
  id: string;
  name: string;
  taxId: string | null;
  email: string | null;
  phone: string | null;
  defaultCategory: string | null;
  defaultCategoryLabel: string | null;
  defaultVatRate: number | null;
  defaultWithholdingRate: number | null;
  defaultWithholdingModel: ExpenseWithholdingModel | null;
  defaultPaymentMethod: ExpensePaymentMethod | null;
  notes: string | null;
  isActive: boolean;
  /** Gastos suyos y lo que cuestan en los últimos 12 meses. */
  expenseCount: number;
  last12Months: number;
  createdAt: string;
}

// --- Categorías propias ---
export const CreateExpenseCategorySchema = z.object({ name: z.string().trim().min(1).max(60) });
export type CreateExpenseCategoryInput = z.infer<typeof CreateExpenseCategorySchema>;

export interface ExpenseCategoryDto {
  /** Clave para el gasto: una de las de siempre o `custom:<id>`. */
  key: string;
  name: string;
  builtin: boolean;
  /** Gastos que la usan. */
  usage: number;
}

// --- Cambios en lote ---
const bulkIds = z.array(z.string().uuid()).min(1).max(200);
export const BulkExpenseActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('category'), ids: bulkIds, category: categoryKey }),
  z.object({
    action: z.literal('facility'),
    ids: bulkIds,
    facilityId: z.string().uuid().nullable(),
  }),
  z.object({
    action: z.literal('mark_paid'),
    ids: bulkIds,
    paidAt: dateOnly,
    paymentMethod: ExpensePaymentMethodEnum,
  }),
  z.object({ action: z.literal('delete'), ids: bulkIds }),
]);
export type BulkExpenseActionInput = z.infer<typeof BulkExpenseActionSchema>;

export interface BulkExpenseResultDto {
  succeeded: number;
  failed: { id: string; error: string }[];
}

// --- Gastos recurrentes (plantillas) ---
export const ExpenseFrequencyEnum = z.enum(['monthly', 'quarterly', 'yearly']);
export const EXPENSE_FREQUENCY_LABELS: Record<z.infer<typeof ExpenseFrequencyEnum>, string> = {
  monthly: 'Cada mes',
  quarterly: 'Cada trimestre',
  yearly: 'Cada año',
};

const RecurringFieldsSchema = z.object({
  facilityId: z.string().uuid().nullish(),
  category: categoryKey.default('other'),
  description: z.string().trim().min(1).max(300),
  amount: expenseAmount.optional(),
  /** Día del mes (1-28) en que se imputa el gasto generado. */
  dayOfMonth: z.number().int().min(1).max(28).default(1),
  active: z.boolean().default(true),
  /** Canal de marketing al que se imputa (se propaga a cada gasto generado). */
  marketingChannelId: z.string().uuid().nullish(),
  frequency: ExpenseFrequencyEnum.default('monthly'),
  /** Mes de inicio (se usa su año y su mes). Por defecto, el actual. */
  startDate: dateOnly.optional(),
  endDate: dateOnly.nullish(),
  supplierId: z.string().uuid().nullish(),
  vendor: optionalText(200),
  vendorTaxId: optionalText(30),
  baseAmount: expenseAmount.nullish(),
  vatRate: rate.nullish(),
  vatDeductible: z.boolean().optional(),
  withholdingRate: rate.nullish(),
  withholdingModel: ExpenseWithholdingModelEnum.nullish(),
  /**
   * Con domiciliación o tarjeta (o sin indicar) el gasto nace pagado; con
   * transferencia, efectivo u otra, pendiente de pagar.
   */
  paymentMethod: ExpensePaymentMethodEnum.nullish(),
});

export const CreateRecurringExpenseSchema = RecurringFieldsSchema.refine(
  (v) => v.amount !== undefined || (v.baseAmount !== undefined && v.baseAmount !== null),
  { message: 'Indica el importe o la base', path: ['amount'] },
);
export type CreateRecurringExpenseInput = z.infer<typeof CreateRecurringExpenseSchema>;

export const UpdateRecurringExpenseSchema = RecurringFieldsSchema.partial();
export type UpdateRecurringExpenseInput = z.infer<typeof UpdateRecurringExpenseSchema>;

export interface RecurringExpenseDto {
  id: string;
  facilityId: string | null;
  facilityName: string | null;
  category: string;
  categoryLabel: string;
  description: string;
  amount: number;
  dayOfMonth: number;
  active: boolean;
  lastGeneratedMonth: string | null;
  marketingChannelId: string | null;
  marketingChannelName: string | null;
  frequency: z.infer<typeof ExpenseFrequencyEnum>;
  startDate: string;
  endDate: string | null;
  supplierId: string | null;
  supplierName: string | null;
  vendor: string | null;
  vendorTaxId: string | null;
  broken: boolean;
  baseAmount: number | null;
  vatRate: number | null;
  vatDeductible: boolean;
  withholdingRate: number | null;
  withholdingModel: ExpenseWithholdingModel | null;
  totalAmount: number;
  paymentMethod: ExpensePaymentMethod | null;
  /** Próxima fecha en que se generará; null si ya terminó o está pausada. */
  nextDate: string | null;
  /** Fechas anteriores que se quedaron sin generar (se pueden generar ahora). */
  missedDates: string[];
  createdAt: string;
}

// --- Presupuesto ---
export const UpdateExpenseBudgetsSchema = z.object({
  budgets: z
    .array(
      z.object({
        category: categoryKey,
        monthlyAmount: z.number().min(0).max(EXPENSE_MAX_AMOUNT),
      }),
    )
    .max(60),
});
export type UpdateExpenseBudgetsInput = z.infer<typeof UpdateExpenseBudgetsSchema>;

export interface ExpenseBudgetDto {
  category: string;
  label: string;
  monthlyAmount: number;
}

// --- Cuenta de resultados (P&L) por local ---

/** Cómo se reparten los gastos generales entre los locales. */
export const ProfitLossAllocationEnum = z.enum(['none', 'units', 'area', 'invoiced']);
export type ProfitLossAllocation = z.infer<typeof ProfitLossAllocationEnum>;
export const PROFIT_LOSS_ALLOCATION_LABELS: Record<ProfitLossAllocation, string> = {
  none: 'Sin repartir',
  units: 'Por número de trasteros',
  area: 'Por m²',
  invoiced: 'Por lo facturado',
};

export interface ProfitLossRowDto {
  /** null = gastos generales sin local asignado. */
  facilityId: string | null;
  facilityName: string;
  /**
   * Facturado en el periodo, sin IVA (como el Resumen: una sustitutiva cuenta
   * solo la diferencia y los abonos restan). 0 sin permiso de facturas.
   */
  invoiced: number;
  /** Cobrado en el periodo (dinero recibido, IVA incluido). 0 sin permiso de cobros. */
  collected: number;
  /** Gastos del local en el periodo. */
  expenses: number;
  /** Parte de los gastos generales que le toca (0 sin repartir). */
  allocatedGeneral: number;
  /** Resultado = facturado sin IVA − gastos − parte de los generales. */
  net: number;
  /** Margen sobre lo facturado (%); null sin facturación. */
  margin: number | null;
}

export interface ProfitLossCategoryDto {
  category: string;
  label: string;
  amount: number;
  /** Presupuesto del periodo (mensual × meses); null si no tiene. */
  budget: number | null;
}

export interface ProfitLossDto {
  from: string;
  to: string;
  allocation: ProfitLossAllocation;
  rows: ProfitLossRowDto[];
  totals: { invoiced: number; collected: number; expenses: number; net: number };
  /** El mismo número de días justo antes. */
  previous: { from: string; to: string; invoiced: number; expenses: number; net: number };
  /** Gastos por categoría (todo el periodo), con su presupuesto. */
  byCategory: ProfitLossCategoryDto[];
  /** Quien no tiene permiso de facturas no ve lo facturado ni el resultado. */
  invoicesVisible: boolean;
  /** Quien no tiene permiso de cobros no ve lo cobrado. */
  paymentsVisible: boolean;
}

export interface ProfitLossMonthDto {
  /** YYYY-MM */
  month: string;
  invoiced: number;
  collected: number;
  expenses: number;
  net: number;
}

export interface ProfitLossMonthlyDto {
  months: ProfitLossMonthDto[];
  invoicesVisible: boolean;
  paymentsVisible: boolean;
}
