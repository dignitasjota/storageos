'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  BulkExpenseActionInput,
  BulkExpenseResultDto,
  CreateExpenseCategoryInput,
  CreateExpenseInput,
  CreateExpenseSupplierInput,
  CreateRecurringExpenseInput,
  ExpenseBudgetDto,
  ExpenseCategoryDto,
  ExpenseDto,
  ExpenseReceiptReadDto,
  ExpenseReceiptUploadDto,
  ExpenseSupplierDto,
  ExpenseTotalDto,
  MarkExpensePaidInput,
  ProfitLossAllocation,
  ProfitLossDto,
  ProfitLossMonthlyDto,
  RecurringExpenseDto,
  UpdateExpenseBudgetsInput,
  UpdateExpenseInput,
  UpdateExpenseSupplierInput,
  UpdateRecurringExpenseInput,
} from '@storageos/shared';

import { apiFetch } from '@/lib/auth/api';

const key = ['expenses'] as const;

function query(filters: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
  return qs.toString();
}

/** Invalida todo lo de gastos (y «Hoy» y la caja, que dependen de ellos). */
function useInvalidateExpenses() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['expense-suppliers'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
    void qc.invalidateQueries({ queryKey: ['cash'] });
  };
}

export function useExpenses(filters: Record<string, string | undefined>) {
  return useQuery({
    queryKey: [...key, filters],
    queryFn: () => apiFetch<ExpenseDto[]>(`/expenses?${query(filters)}`),
  });
}

/** Número, importe y pendiente de los gastos con estos filtros. */
export function useExpensesTotal(filters: Record<string, string | undefined>) {
  return useQuery({
    queryKey: [...key, 'total', filters],
    queryFn: () => apiFetch<ExpenseTotalDto>(`/expenses/total?${query(filters)}`),
  });
}

/** Todo lo filtrado (hasta 5.000) para el CSV. */
export function fetchExpensesExport(filters: Record<string, string | undefined>) {
  return apiFetch<ExpenseDto[]>(`/expenses/export?${query(filters)}`);
}

export function useProfitLoss(from: string, to: string, allocation: ProfitLossAllocation = 'none') {
  return useQuery({
    queryKey: [...key, 'profit-loss', from, to, allocation],
    queryFn: () =>
      apiFetch<ProfitLossDto>(
        `/expenses/profit-loss?from=${from}&to=${to}&allocation=${allocation}`,
      ),
    enabled: Boolean(from && to),
  });
}

export function useProfitLossMonthly(from: string, to: string, facilityId?: string) {
  return useQuery({
    queryKey: [...key, 'profit-loss-monthly', from, to, facilityId ?? null],
    queryFn: () =>
      apiFetch<ProfitLossMonthlyDto>(
        `/expenses/profit-loss/monthly?${query({ from, to, facilityId })}`,
      ),
    enabled: Boolean(from && to),
  });
}

export function useCreateExpense() {
  const invalidate = useInvalidateExpenses();
  return useMutation({
    mutationFn: (input: CreateExpenseInput) =>
      apiFetch<ExpenseDto>('/expenses', { method: 'POST', json: input }),
    onSuccess: invalidate,
  });
}

export function useUpdateExpense() {
  const invalidate = useInvalidateExpenses();
  return useMutation({
    mutationFn: (args: { id: string; input: UpdateExpenseInput }) =>
      apiFetch<ExpenseDto>(`/expenses/${args.id}`, { method: 'PATCH', json: args.input }),
    onSuccess: invalidate,
  });
}

export function useDeleteExpense() {
  const invalidate = useInvalidateExpenses();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/expenses/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

export function useMarkExpensePaid() {
  const invalidate = useInvalidateExpenses();
  return useMutation({
    mutationFn: (args: { id: string; input: MarkExpensePaidInput }) =>
      apiFetch<ExpenseDto>(`/expenses/${args.id}/mark-paid`, { method: 'POST', json: args.input }),
    onSuccess: invalidate,
  });
}

export function useMarkExpensePending() {
  const invalidate = useInvalidateExpenses();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<ExpenseDto>(`/expenses/${id}/mark-pending`, { method: 'POST' }),
    onSuccess: invalidate,
  });
}

export function useBulkExpenses() {
  const invalidate = useInvalidateExpenses();
  return useMutation({
    mutationFn: (input: BulkExpenseActionInput) =>
      apiFetch<BulkExpenseResultDto>('/expenses/bulk', { method: 'POST', json: input }),
    onSuccess: invalidate,
  });
}

/** Sube el justificante a la URL firmada y devuelve su clave. */
export async function uploadExpenseReceipt(file: File): Promise<string> {
  const presign = await apiFetch<ExpenseReceiptUploadDto>('/expenses/receipt-upload-url', {
    method: 'POST',
    json: { mimeType: file.type },
  });
  const res = await fetch(presign.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': file.type },
    body: file,
  });
  if (!res.ok) throw new Error('No se ha podido subir el justificante');
  return presign.key;
}

export function useReadExpenseReceipt() {
  return useMutation({
    mutationFn: (receiptKey: string) =>
      apiFetch<ExpenseReceiptReadDto>('/expenses/receipts/read', {
        method: 'POST',
        json: { key: receiptKey },
      }),
  });
}

export function fetchExpenseReceiptUrl(id: string) {
  return apiFetch<{ url: string }>(`/expenses/${id}/receipt`);
}

// --- proveedores ---
const suppliersKey = ['expense-suppliers'] as const;

export function useExpenseSuppliers(includeInactive = false) {
  return useQuery({
    queryKey: [...suppliersKey, includeInactive],
    queryFn: () =>
      apiFetch<ExpenseSupplierDto[]>(`/expense-suppliers${includeInactive ? '?all=1' : ''}`),
  });
}

export function useCreateExpenseSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateExpenseSupplierInput) =>
      apiFetch<ExpenseSupplierDto>('/expense-suppliers', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: suppliersKey }),
  });
}

export function useUpdateExpenseSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: UpdateExpenseSupplierInput }) =>
      apiFetch<ExpenseSupplierDto>(`/expense-suppliers/${args.id}`, {
        method: 'PATCH',
        json: args.input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: suppliersKey }),
  });
}

export function useDeleteExpenseSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/expense-suppliers/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: suppliersKey }),
  });
}

// --- categorías y presupuesto ---
const categoriesKey = ['expenses', 'categories'] as const;

export function useExpenseCategories() {
  return useQuery({
    queryKey: categoriesKey,
    queryFn: () => apiFetch<ExpenseCategoryDto[]>('/expense-categories'),
    staleTime: 60_000,
  });
}

export function useCreateExpenseCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateExpenseCategoryInput) =>
      apiFetch<ExpenseCategoryDto>('/expense-categories', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: categoriesKey }),
  });
}

export function useRenameExpenseCategory() {
  const invalidate = useInvalidateExpenses();
  return useMutation({
    mutationFn: (args: { id: string; name: string }) =>
      apiFetch<void>(`/expense-categories/${args.id}`, {
        method: 'PATCH',
        json: { name: args.name },
      }),
    onSuccess: invalidate,
  });
}

export function useDeleteExpenseCategory() {
  const invalidate = useInvalidateExpenses();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ moved: number }>(`/expense-categories/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

export function useExpenseBudgets() {
  return useQuery({
    queryKey: [...key, 'budgets'],
    queryFn: () => apiFetch<ExpenseBudgetDto[]>('/expenses/budgets'),
  });
}

export function useSetExpenseBudgets() {
  const invalidate = useInvalidateExpenses();
  return useMutation({
    mutationFn: (input: UpdateExpenseBudgetsInput) =>
      apiFetch<ExpenseBudgetDto[]>('/expenses/budgets', { method: 'PUT', json: input }),
    onSuccess: invalidate,
  });
}

// --- recurrentes ---
const recurringKey = ['expenses', 'recurring'] as const;

export function useRecurringExpenses() {
  return useQuery({
    queryKey: recurringKey,
    queryFn: () => apiFetch<RecurringExpenseDto[]>('/expenses/recurring'),
  });
}

export function useCreateRecurringExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRecurringExpenseInput) =>
      apiFetch<RecurringExpenseDto>('/expenses/recurring', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: recurringKey }),
  });
}

export function useUpdateRecurringExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: UpdateRecurringExpenseInput }) =>
      apiFetch<RecurringExpenseDto>(`/expenses/recurring/${args.id}`, {
        method: 'PATCH',
        json: args.input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: recurringKey }),
  });
}

export function useDeleteRecurringExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/expenses/recurring/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: recurringKey }),
  });
}

export function useRunRecurringExpenses() {
  const invalidate = useInvalidateExpenses();
  return useMutation({
    mutationFn: () => apiFetch<{ created: number }>('/expenses/recurring/run', { method: 'POST' }),
    onSuccess: invalidate,
  });
}

export function useCatchUpRecurringExpense() {
  const invalidate = useInvalidateExpenses();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ created: number }>(`/expenses/recurring/${id}/catch-up`, { method: 'POST' }),
    onSuccess: invalidate,
  });
}
