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

export const CreateExpenseSchema = z.object({
  /** Local al que se imputa el gasto; null/ausente = gasto general de la empresa. */
  facilityId: z.string().uuid().nullish(),
  category: ExpenseCategoryEnum.default('other'),
  description: z.string().trim().min(1).max(300),
  amount: z.number().positive().finite(),
  expenseDate: dateOnly,
  vendor: z.string().trim().max(200).optional().or(z.literal('')),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
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
  createdAt: string;
}

// --- Gastos recurrentes (plantilla mensual) ---
export const CreateRecurringExpenseSchema = z.object({
  facilityId: z.string().uuid().nullish(),
  category: ExpenseCategoryEnum.default('other'),
  description: z.string().trim().min(1).max(300),
  amount: z.number().positive().finite(),
  /** Día del mes (1-28) en que se imputa el gasto generado. */
  dayOfMonth: z.number().int().min(1).max(28).default(1),
  active: z.boolean().default(true),
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
  createdAt: string;
}

// --- Cuenta de resultados (P&L) por local ---
export interface ProfitLossRowDto {
  /** null = gastos generales sin local asignado. */
  facilityId: string | null;
  facilityName: string;
  /** Facturado en el periodo (facturas emitidas, base+IVA, no borrador/anuladas). */
  invoiced: number;
  /** Cobrado en el periodo (pagos con éxito). */
  collected: number;
  /** Gastos imputados en el periodo. */
  expenses: number;
  /** Resultado = facturado − gastos. */
  net: number;
}

export interface ProfitLossDto {
  from: string;
  to: string;
  rows: ProfitLossRowDto[];
  totals: { invoiced: number; collected: number; expenses: number; net: number };
  /** Gastos por categoría (todo el periodo). */
  byCategory: { category: ExpenseCategory; amount: number }[];
}
