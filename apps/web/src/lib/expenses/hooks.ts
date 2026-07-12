'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  CreateExpenseInput,
  ExpenseDto,
  ProfitLossDto,
  UpdateExpenseInput,
} from '@storageos/shared';

import { apiFetch } from '@/lib/auth/api';

const key = ['expenses'] as const;

export function useExpenses(filters: {
  facilityId?: string;
  category?: string;
  from?: string;
  to?: string;
}) {
  const qs = new URLSearchParams();
  if (filters.facilityId) qs.set('facilityId', filters.facilityId);
  if (filters.category) qs.set('category', filters.category);
  if (filters.from) qs.set('from', filters.from);
  if (filters.to) qs.set('to', filters.to);
  const suffix = qs.toString() ? `?${qs}` : '';
  return useQuery({
    queryKey: [...key, filters],
    queryFn: () => apiFetch<ExpenseDto[]>(`/expenses${suffix}`),
  });
}

export function useProfitLoss(from: string, to: string) {
  return useQuery({
    queryKey: [...key, 'profit-loss', from, to],
    queryFn: () => apiFetch<ProfitLossDto>(`/expenses/profit-loss?from=${from}&to=${to}`),
    enabled: Boolean(from && to),
  });
}

export function useCreateExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateExpenseInput) =>
      apiFetch<ExpenseDto>('/expenses', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useUpdateExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: UpdateExpenseInput }) =>
      apiFetch<ExpenseDto>(`/expenses/${args.id}`, { method: 'PATCH', json: args.input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useDeleteExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/expenses/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}
