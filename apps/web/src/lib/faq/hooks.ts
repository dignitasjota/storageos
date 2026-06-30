'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { CreateFaqEntryInput, FaqEntryDto, UpdateFaqEntryInput } from '@storageos/shared';

import { apiFetch } from '@/lib/auth/api';

const faqKey = ['faq-entries'] as const;

export function useFaqEntries() {
  return useQuery({
    queryKey: faqKey,
    queryFn: () => apiFetch<FaqEntryDto[]>('/faq-entries'),
  });
}

export function useCreateFaqEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateFaqEntryInput) =>
      apiFetch<FaqEntryDto>('/faq-entries', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: faqKey }),
  });
}

export function useUpdateFaqEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: UpdateFaqEntryInput }) =>
      apiFetch<FaqEntryDto>(`/faq-entries/${args.id}`, { method: 'PATCH', json: args.input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: faqKey }),
  });
}

export function useDeleteFaqEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/faq-entries/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: faqKey }),
  });
}
