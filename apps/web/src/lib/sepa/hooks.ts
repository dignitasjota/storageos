import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  CreateRemittanceInput,
  CreateSepaMandateInput,
  RemittancePreviewDto,
  SepaMandateDto,
  SepaRemittanceDto,
  SepaRemittancePrenoticeDto,
  SepaSettingsDto,
  UpdateSepaSettingsInput,
} from '@storageos/shared';

const settingsKey = ['sepa', 'settings'] as const;
const remittancesKey = ['sepa', 'remittances'] as const;
const mandatesKey = ['sepa', 'mandates'] as const;

export function useSepaSettings(enabled = true) {
  return useQuery({
    queryKey: settingsKey,
    queryFn: () => apiFetch<SepaSettingsDto>('/sepa/settings'),
    enabled,
  });
}

export function useUpdateSepaSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSepaSettingsInput) =>
      apiFetch<SepaSettingsDto>('/sepa/settings', { method: 'PUT', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKey }),
  });
}

export function useSepaMandates(customerId: string | undefined) {
  return useQuery({
    queryKey: [...mandatesKey, customerId] as const,
    queryFn: () => apiFetch<SepaMandateDto[]>(`/sepa/mandates?customerId=${customerId}`),
    enabled: !!customerId,
  });
}

export function useCreateSepaMandate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSepaMandateInput) =>
      apiFetch<SepaMandateDto>('/sepa/mandates', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: mandatesKey }),
  });
}

export function useCancelSepaMandate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/sepa/mandates/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: mandatesKey }),
  });
}

export function useRemittancePreview() {
  return useMutation({
    mutationFn: () =>
      apiFetch<RemittancePreviewDto>('/sepa/remittances/preview', { method: 'POST' }),
  });
}

export function useSepaRemittances() {
  return useQuery({
    queryKey: remittancesKey,
    queryFn: () => apiFetch<SepaRemittanceDto[]>('/sepa/remittances'),
  });
}

/** Constancia del preaviso de cada adeudo (se refresca mientras haya pendientes). */
export function useRemittancePrenotices(id: string | null) {
  return useQuery({
    queryKey: [...remittancesKey, id, 'prenotices'] as const,
    queryFn: () => apiFetch<SepaRemittancePrenoticeDto[]>(`/sepa/remittances/${id}/prenotices`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.some((p) => p.status === null) ? 3000 : false),
  });
}

export function useCreateRemittance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRemittanceInput) =>
      apiFetch<SepaRemittanceDto>('/sepa/remittances', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: remittancesKey }),
  });
}

/** Confirma el cobro; `rejectedItemIds` = adeudos que el banco rechazó (no se cobran). */
export function useConfirmRemittance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; rejectedItemIds: string[] }) =>
      apiFetch<SepaRemittanceDto>(`/sepa/remittances/${args.id}/confirm`, {
        method: 'POST',
        json: { rejectedItemIds: args.rejectedItemIds },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: remittancesKey }),
  });
}

/** Cancela una remesa sin confirmar: sus facturas vuelven a poder cobrarse. */
export function useCancelRemittance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<SepaRemittanceDto>(`/sepa/remittances/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: remittancesKey }),
  });
}

/** Descarga el XML pain.008 de una remesa (blob en el cliente). */
export async function downloadRemittanceXml(id: string): Promise<void> {
  const { filename, xml } = await apiFetch<{ filename: string; xml: string }>(
    `/sepa/remittances/${id}/xml`,
  );
  const blob = new Blob([xml], { type: 'application/xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
