import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';
import { invalidateBilling } from '../billing/hooks';

import type {
  CreateRemittanceInput,
  CreateSepaMandateInput,
  MarkSepaItemReturnedInput,
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

/** Vuelve a mandar al inquilino el enlace para firmar el mandato. */
export function useResendMandateSigning() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<SepaMandateDto>(`/sepa/mandates/${id}/signing-link`, { method: 'POST' }),
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

export function useSepaRemittances(enabled = true) {
  return useQuery({
    queryKey: remittancesKey,
    queryFn: () => apiFetch<SepaRemittanceDto[]>('/sepa/remittances'),
    enabled,
    // Mientras salen los preavisos de una remesa recién generada.
    refetchInterval: (q) =>
      q.state.data?.some(
        (r) => r.status === 'generated' && r.prenoticesSent + r.prenoticesMissing < r.itemCount,
      )
        ? 5000
        : false,
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

/** Tras generar, confirmar, cancelar o devolver: la remesa y lo que mira los cobros. */
function useAfterRemittance() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: remittancesKey });
    invalidateBilling(qc);
  };
}

export function useCreateRemittance() {
  const onSuccess = useAfterRemittance();
  return useMutation({
    mutationFn: (input: CreateRemittanceInput) =>
      apiFetch<SepaRemittanceDto>('/sepa/remittances', { method: 'POST', json: input }),
    onSuccess,
  });
}

/** Registra el resultado del banco; `rejectedItemIds` = adeudos que rechazó (no se cobran). */
export function useConfirmRemittance() {
  const onSuccess = useAfterRemittance();
  return useMutation({
    mutationFn: (args: { id: string; rejectedItemIds: string[] }) =>
      apiFetch<SepaRemittanceDto>(`/sepa/remittances/${args.id}/confirm`, {
        method: 'POST',
        json: { rejectedItemIds: args.rejectedItemIds },
      }),
    onSuccess,
  });
}

/** Cancela una remesa sin confirmar: sus facturas vuelven a poder cobrarse. */
export function useCancelRemittance() {
  const onSuccess = useAfterRemittance();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<SepaRemittanceDto>(`/sepa/remittances/${id}/cancel`, { method: 'POST' }),
    onSuccess,
  });
}

/** Un adeudo cobrado que el banco devolvió (sin fichero N43). */
export function useMarkSepaItemReturned() {
  const onSuccess = useAfterRemittance();
  return useMutation({
    mutationFn: (args: {
      remittanceId: string;
      itemId: string;
      input: MarkSepaItemReturnedInput;
    }) =>
      apiFetch<SepaRemittanceDto>(
        `/sepa/remittances/${args.remittanceId}/items/${args.itemId}/return`,
        { method: 'POST', json: args.input },
      ),
    onSuccess,
  });
}

/** Reenvía los preavisos que no salieron de una remesa sin confirmar. */
export function useResendPrenotices() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (remittanceId: string) =>
      apiFetch<{ resent: number }>(`/sepa/remittances/${remittanceId}/prenotices/resend`, {
        method: 'POST',
      }),
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
