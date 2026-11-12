import { z } from 'zod';

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

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD');

/** Importe máximo de un gasto (la columna admite 12 cifras con 2 decimales). */
export const EXPENSE_MAX_AMOUNT = 99_999_999.99;
const expenseAmount = z
  .number()
  .positive()
  .finite()
  .max(EXPENSE_MAX_AMOUNT, 'El importe es demasiado alto');

/** De dónde sale un gasto: a mano, de una plantilla recurrente o de una plataforma de anuncios. */
export type ExpenseSource = 'manual' | 'recurring' | 'google_ads' | 'meta_ads';

export const EXPENSE_SOURCE_LABELS: Record<ExpenseSource, string> = {
  manual: 'A mano',
  recurring: 'Recurrente',
  google_ads: 'Google Ads',
  meta_ads: 'Meta Ads',
};

export const CreateExpenseSchema = z.object({
  /** Local al que se imputa el gasto; null/ausente = gasto general de la empresa. */
  facilityId: z.string().uuid().nullish(),
  category: ExpenseCategoryEnum.default('other'),
  description: z.string().trim().min(1).max(300),
  amount: expenseAmount,
  expenseDate: dateOnly,
  vendor: z.string().trim().max(200).optional().or(z.literal('')),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
  /** Canal de marketing al que se imputa (solo aplica con category='marketing'). */
  marketingChannelId: z.string().uuid().nullish(),
});
export type CreateExpenseInput = z.infer<typeof CreateExpenseSchema>;

export const UpdateExpenseSchema = CreateExpenseSchema.partial();
export type UpdateExpenseInput = z.infer<typeof UpdateExpenseSchema>;

export interface ExpenseDto {
  id: string;
  facilityId: string | null;
  facilityName: string | null;
  category: ExpenseCategory;
  description: string;
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
  createdAt: string;
}

// --- Gastos recurrentes (plantilla mensual) ---
export const CreateRecurringExpenseSchema = z.object({
  facilityId: z.string().uuid().nullish(),
  category: ExpenseCategoryEnum.default('other'),
  description: z.string().trim().min(1).max(300),
  amount: expenseAmount,
  /** Día del mes (1-28) en que se imputa el gasto generado. */
  dayOfMonth: z.number().int().min(1).max(28).default(1),
  active: z.boolean().default(true),
  /** Canal de marketing al que se imputa (se propaga a cada gasto generado). */
  marketingChannelId: z.string().uuid().nullish(),
});
export type CreateRecurringExpenseInput = z.infer<typeof CreateRecurringExpenseSchema>;

export const UpdateRecurringExpenseSchema = CreateRecurringExpenseSchema.partial();
export type UpdateRecurringExpenseInput = z.infer<typeof UpdateRecurringExpenseSchema>;

export interface RecurringExpenseDto {
  id: string;
  facilityId: string | null;
  facilityName: string | null;
  category: ExpenseCategory;
  description: string;
  amount: number;
  dayOfMonth: number;
  active: boolean;
  lastGeneratedMonth: string | null;
  marketingChannelId: string | null;
  marketingChannelName: string | null;
  createdAt: string;
}

// --- Cuenta de resultados (P&L) por local ---
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
  /** Gastos imputados en el periodo. */
  expenses: number;
  /** Resultado = facturado sin IVA − gastos. */
  net: number;
}

export interface ProfitLossDto {
  from: string;
  to: string;
  rows: ProfitLossRowDto[];
  totals: { invoiced: number; collected: number; expenses: number; net: number };
  /** Gastos por categoría (todo el periodo). */
  byCategory: { category: ExpenseCategory; amount: number }[];
  /** Quien no tiene permiso de facturas no ve lo facturado ni el resultado. */
  invoicesVisible: boolean;
  /** Quien no tiene permiso de cobros no ve lo cobrado. */
  paymentsVisible: boolean;
}
