import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  CreateRentIncreaseInput,
  PreviewRentIncreaseInput,
  PreviewRentIncreaseNoticeInput,
  RentIncreaseDto,
  RentIncreaseNoticePreviewDto,
  RentIncreaseNoticeTemplate,
  RentIncreaseNoticeTemplateDto,
  RentIncreasePolicyDto,
  RentIncreasePolicyInput,
  RentIncreasePreviewDto,
  RentIncreaseResultsDto,
} from '@storageos/shared';

const key = ['rent-increases'] as const;

export function useRentIncreases() {
  return useQuery({
    queryKey: key,
    queryFn: () => apiFetch<RentIncreaseDto[]>('/rent-increases'),
  });
}

export function useRentIncrease(id: string | undefined) {
  return useQuery({
    queryKey: [...key, id] as const,
    queryFn: () => apiFetch<RentIncreaseDto>(`/rent-increases/${id}`),
    enabled: !!id,
  });
}

export function usePreviewRentIncrease() {
  return useMutation({
    mutationFn: (input: PreviewRentIncreaseInput) =>
      apiFetch<RentIncreasePreviewDto>('/rent-increases/preview', { method: 'POST', json: input }),
  });
}

export function useCreateRentIncrease() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRentIncreaseInput) =>
      apiFetch<RentIncreaseDto>('/rent-increases', { method: 'POST', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ['contracts'] });
      void qc.invalidateQueries({ queryKey: ['portfolio'] });
    },
  });
}

export function useApplyRentIncrease() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<RentIncreaseDto>(`/rent-increases/${id}/apply`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ['contracts'] });
      void qc.invalidateQueries({ queryKey: ['portfolio'] });
    },
  });
}

export function useCancelRentIncrease() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<RentIncreaseDto>(`/rent-increases/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ['contracts'] });
      void qc.invalidateQueries({ queryKey: ['portfolio'] });
    },
  });
}

const policyKey = ['rent-increases', 'policy'] as const;

export function useRentIncreasePolicy() {
  return useQuery({
    queryKey: policyKey,
    queryFn: () => apiFetch<RentIncreasePolicyDto>('/rent-increases/policy'),
    staleTime: 60_000,
  });
}

export function useUpdateRentIncreasePolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RentIncreasePolicyInput) =>
      apiFetch<RentIncreasePolicyDto>('/rent-increases/policy', { method: 'PATCH', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: policyKey }),
  });
}

const templateKey = ['rent-increases', 'notice-template'] as const;

export function useRentIncreaseNoticeTemplate() {
  return useQuery({
    queryKey: templateKey,
    queryFn: () => apiFetch<RentIncreaseNoticeTemplateDto>('/rent-increases/notice-template'),
    staleTime: 60_000,
  });
}

export function useUpdateRentIncreaseNoticeTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (template: RentIncreaseNoticeTemplate | null) =>
      apiFetch<RentIncreaseNoticeTemplateDto>('/rent-increases/notice-template', {
        method: 'PUT',
        json: { template },
      }),
    onSuccess: (data) => qc.setQueryData(templateKey, data),
  });
}

export function usePreviewRentIncreaseNotice() {
  return useMutation({
    mutationFn: (input: Partial<PreviewRentIncreaseNoticeInput>) =>
      apiFetch<RentIncreaseNoticePreviewDto>('/rent-increases/notice-preview', {
        method: 'POST',
        json: input,
      }),
  });
}

export function useRentIncreaseResults(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: [...key, id, 'results'] as const,
    queryFn: () => apiFetch<RentIncreaseResultsDto>(`/rent-increases/${id}/results`),
    enabled: !!id && enabled,
  });
}

/** Quitar un contrato de la subida o volver a enviarle el aviso. */
export function useRentIncreaseItemAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; itemId: string; action: 'remove' | 'resend' }) =>
      apiFetch<RentIncreaseDto>(`/rent-increases/${args.id}/items/${args.itemId}/${args.action}`, {
        method: 'POST',
      }),
    onSuccess: (data) => {
      qc.setQueryData([...key, data.id], data);
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ['contracts'] });
      void qc.invalidateQueries({ queryKey: ['portfolio'] });
    },
  });
}
