import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  GoCardlessMandateCompleteInput,
  GoCardlessMandateStartDto,
  GoCardlessSettingsDto,
  GoCardlessTestResultDto,
  PaymentMethodDto,
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

/** Staff: inicia el mandato de un inquilino → URL de autorización. */
export function useStartGoCardlessMandate() {
  return useMutation({
    mutationFn: (customerId: string) =>
      apiFetch<GoCardlessMandateStartDto>('/settings/gocardless/mandate/start', {
        method: 'POST',
        json: { customerId },
      }),
  });
}

/** Staff: completa el mandato tras la autorización → registra el método de pago. */
export function useCompleteGoCardlessMandate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: GoCardlessMandateCompleteInput) =>
      apiFetch<PaymentMethodDto>('/settings/gocardless/mandate/complete', {
        method: 'POST',
        json: input,
      }),
    onSuccess: (_pm, input) =>
      qc.invalidateQueries({ queryKey: ['payment-methods', input.customerId] }),
  });
}

// --- Portal (inquilino), con el token de portal en el header ---------------

function portalAuth(portalToken: string) {
  return { requiresAuth: false as const, headers: { Authorization: `Bearer ${portalToken}` } };
}

export function fetchGoCardlessEnabledPortal(portalToken: string): Promise<{ enabled: boolean }> {
  return apiFetch<{ enabled: boolean }>('/portal/me/gocardless/enabled', portalAuth(portalToken));
}

export function startGoCardlessMandatePortal(
  portalToken: string,
): Promise<GoCardlessMandateStartDto> {
  return apiFetch<GoCardlessMandateStartDto>('/portal/me/gocardless/mandate/start', {
    method: 'POST',
    ...portalAuth(portalToken),
  });
}

export function completeGoCardlessMandatePortal(
  portalToken: string,
  billingRequestId: string,
): Promise<PaymentMethodDto> {
  return apiFetch<PaymentMethodDto>('/portal/me/gocardless/mandate/complete', {
    method: 'POST',
    ...portalAuth(portalToken),
    json: { billingRequestId },
  });
}
