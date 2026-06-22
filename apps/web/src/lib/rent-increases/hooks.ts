import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  CreateRentIncreaseInput,
  PreviewRentIncreaseInput,
  RentIncreaseDto,
  RentIncreasePreviewDto,
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
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useApplyRentIncrease() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<RentIncreaseDto>(`/rent-increases/${id}/apply`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useCancelRentIncrease() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<RentIncreaseDto>(`/rent-increases/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}
