import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  GoCardlessSettingsDto,
  GoCardlessTestResultDto,
  UpdateGoCardlessSettingsInput,
} from '@storageos/shared';

const goCardlessKey = ['gocardless-settings'] as const;

export function useGoCardlessSettings() {
  return useQuery({
    queryKey: goCardlessKey,
    queryFn: () => apiFetch<GoCardlessSettingsDto>('/settings/gocardless'),
  });
}

export function useUpdateGoCardlessSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateGoCardlessSettingsInput) =>
      apiFetch<GoCardlessSettingsDto>('/settings/gocardless', { method: 'PUT', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: goCardlessKey }),
  });
}

/** Prueba la conexión con el access token guardado. */
export function useTestGoCardless() {
  return useMutation({
    mutationFn: () =>
      apiFetch<GoCardlessTestResultDto>('/settings/gocardless/test', { method: 'POST' }),
  });
}
