import { useMutation, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';
import { rgpdKey } from '../billing/hooks';

import type {
  CreateDataSubjectRequestInput,
  DataSubjectRequestDto,
  UpdateDataSubjectRequestInput,
} from '@storageos/shared';

export function useCreateDataSubjectRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDataSubjectRequestInput) =>
      apiFetch<DataSubjectRequestDto>('/rgpd/requests', { method: 'POST', json: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: rgpdKey }),
  });
}

export function useUpdateDataSubjectRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateDataSubjectRequestInput }) =>
      apiFetch<DataSubjectRequestDto>(`/rgpd/requests/${id}`, { method: 'PATCH', json: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: rgpdKey }),
  });
}

/** Descarga en JSON todos los datos de un inquilino (derecho de acceso y portabilidad). */
export function useExportCustomerData() {
  return useMutation({
    mutationFn: async (customerId: string) => {
      const data = await apiFetch<Record<string, unknown>>(`/rgpd/customers/${customerId}/export`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `datos-inquilino-${customerId}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },
  });
}

/** Anonimiza al inquilino; con `requestId` la solicitud queda atendida. */
export function useAnonymizeCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ customerId, requestId }: { customerId: string; requestId?: string }) =>
      apiFetch<void>(
        `/rgpd/customers/${customerId}/anonymize${requestId ? `?requestId=${requestId}` : ''}`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: rgpdKey });
      void qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}
