import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { create } from 'zustand';

import { apiFetch } from '../auth/api';

/**
 * Emisor de los informes (plan Administrador): null = tu empresa; un id = ese
 * propietario (cada uno declara lo suyo).
 */
export const useFiscalOwner = create<{
  ownerId: string | null;
  setOwnerId: (id: string | null) => void;
}>((set) => ({ ownerId: null, setOwnerId: (ownerId) => set({ ownerId }) }));

/** `&ownerId=…` para las peticiones fiscales del emisor elegido. */
export function ownerQs(ownerId: string | null): string {
  return ownerId ? `&ownerId=${ownerId}` : '';
}

import type {
  AccountantExportDto,
  AccountantSendResultDto,
  AccountantSettingsDto,
  FiscalChecksDto,
  FiscalClosureDto,
  Model303Dto,
  Model347Dto,
  ReceivedInvoicesBookDto,
  UpdateAccountantSettingsInput,
  VatBookDto,
  WithholdingsDto,
} from '@storageos/shared';

export function useVatBook(from: string, to: string, enabled = true) {
  const ownerId = useFiscalOwner((st) => st.ownerId);
  return useQuery({
    queryKey: ['fiscal', 'vat-book', from, to, ownerId] as const,
    queryFn: () =>
      apiFetch<VatBookDto>(`/fiscal/vat-book?from=${from}&to=${to}${ownerQs(ownerId)}`),
    enabled: enabled && !!from && !!to,
  });
}

export function useModel303(year: number, quarter: number) {
  const ownerId = useFiscalOwner((st) => st.ownerId);
  return useQuery({
    queryKey: ['fiscal', 'model-303', year, quarter, ownerId] as const,
    queryFn: () =>
      apiFetch<Model303Dto>(`/fiscal/model-303?year=${year}&quarter=${quarter}${ownerQs(ownerId)}`),
  });
}

export function useModel347(year: number) {
  const ownerId = useFiscalOwner((st) => st.ownerId);
  return useQuery({
    queryKey: ['fiscal', 'model-347', year, ownerId] as const,
    queryFn: () => apiFetch<Model347Dto>(`/fiscal/model-347?year=${year}${ownerQs(ownerId)}`),
  });
}

/** Vista previa de la exportación para la asesoría (facturas, cobros y fianzas). */
export function useAccountantExport(from: string, to: string, enabled = true) {
  const ownerId = useFiscalOwner((st) => st.ownerId);
  return useQuery({
    queryKey: ['fiscal', 'accountant-export', from, to, ownerId] as const,
    queryFn: () =>
      apiFetch<AccountantExportDto>(
        `/fiscal/accountant-export?from=${from}&to=${to}${ownerQs(ownerId)}`,
      ),
    enabled: enabled && !!from && !!to,
  });
}

export { downloadCsv } from '@/lib/csv';

// --- Fiscalidad (PR B): libros, retenciones, revisión, cierre y asesoría ---

export function useReceivedBook(from: string, to: string) {
  const ownerId = useFiscalOwner((st) => st.ownerId);
  return useQuery({
    queryKey: ['fiscal', 'received-book', from, to, ownerId] as const,
    queryFn: () =>
      apiFetch<ReceivedInvoicesBookDto>(
        `/fiscal/received-book?from=${from}&to=${to}${ownerQs(ownerId)}`,
      ),
    enabled: !!from && !!to,
  });
}

export function useWithholdings(year: number, quarter: number) {
  const ownerId = useFiscalOwner((st) => st.ownerId);
  return useQuery({
    queryKey: ['fiscal', 'withholdings', year, quarter, ownerId] as const,
    queryFn: () =>
      apiFetch<WithholdingsDto>(
        `/fiscal/withholdings?year=${year}&quarter=${quarter}${ownerQs(ownerId)}`,
      ),
  });
}

export function useFiscalChecks(year: number, quarter: number) {
  return useQuery({
    queryKey: ['fiscal', 'checks', year, quarter] as const,
    queryFn: () => apiFetch<FiscalChecksDto>(`/fiscal/checks?year=${year}&quarter=${quarter}`),
  });
}

export function useFiscalClosures() {
  return useQuery({
    queryKey: ['fiscal', 'closures'] as const,
    queryFn: () => apiFetch<FiscalClosureDto[]>('/fiscal/closures'),
  });
}

export function useCloseQuarter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { year: number; quarter: number }) =>
      apiFetch<FiscalClosureDto>('/fiscal/closures', { method: 'POST', json: body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['fiscal'] }),
  });
}

export function useReopenQuarter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      apiFetch<FiscalClosureDto>(`/fiscal/closures/${id}/reopen`, {
        method: 'POST',
        json: { reason },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['fiscal'] }),
  });
}

export function useAccountantSettings() {
  return useQuery({
    queryKey: ['fiscal', 'accountant'] as const,
    queryFn: () => apiFetch<AccountantSettingsDto>('/fiscal/accountant'),
  });
}

export function useUpdateAccountantSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateAccountantSettingsInput) =>
      apiFetch<AccountantSettingsDto>('/fiscal/accountant', { method: 'PUT', json: body }),
    onSuccess: (data) => qc.setQueryData(['fiscal', 'accountant'], data),
  });
}

export function useSendToAccountant() {
  return useMutation({
    mutationFn: (body: { from: string; to: string }) =>
      apiFetch<AccountantSendResultDto>('/fiscal/accountant/send', { method: 'POST', json: body }),
  });
}

/** Año y trimestre de hoy. */
export function currentQuarter(): { year: number; quarter: number } {
  const now = new Date();
  return { year: now.getFullYear(), quarter: Math.floor(now.getMonth() / 3) + 1 };
}

/** Primer y último día de un trimestre (YYYY-MM-DD). */
export function quarterBounds(year: number, quarter: number): { from: string; to: string } {
  const first = (quarter - 1) * 3 + 1;
  const last = new Date(Date.UTC(year, quarter * 3, 0)).getUTCDate();
  return {
    from: `${year}-${String(first).padStart(2, '0')}-01`,
    to: `${year}-${String(quarter * 3).padStart(2, '0')}-${last}`,
  };
}
