import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError, apiFetch } from '../auth/api';

import { invoiceKey } from './hooks';

/**
 * Metadata pública del certificado AEAT cargado por el tenant. La definimos
 * local al frontend para evitar acoplar @storageos/shared a un detalle de
 * Fase 10A. Si más adelante se reutiliza desde el portal o admin, se sube
 * al paquete compartido.
 */
export interface AeatCredentialMetadata {
  id: string;
  certCommonName: string;
  certNif: string;
  certIssuer: string;
  /** ISO-8601. */
  certValidFrom: string;
  /** ISO-8601. */
  certValidTo: string;
  environment: 'sandbox' | 'production';
  /** ISO-8601. */
  uploadedAt: string;
  /** ISO-8601 si está revocada, null si está activa. */
  revokedAt: string | null;
  revokedReason: string | null;
}

export const verifactuCredentialKey = ['billing', 'aeat-credential'] as const;
export const verifactuCredentialHistoryKey = ['billing', 'aeat-credential', 'history'] as const;

export interface UploadVerifactuCredentialInput {
  file: File;
  password: string;
  environment: 'sandbox' | 'production';
}

/**
 * GET /billing/aeat-credentials/me. Maneja 404 como "no hay credencial" en
 * lugar de propagar el error: la UI necesita poder distinguir "vacío" de
 * "error de red".
 */
export function useVerifactuCredentialQuery() {
  return useQuery<AeatCredentialMetadata | null>({
    queryKey: verifactuCredentialKey,
    queryFn: async () => {
      try {
        return await apiFetch<AeatCredentialMetadata>('/billing/aeat-credentials/me');
      } catch (err) {
        if (err instanceof ApiError && err.statusCode === 404) {
          return null;
        }
        throw err;
      }
    },
    staleTime: 30_000,
  });
}

/** POST /billing/aeat-credentials (multipart/form-data, requiere rol owner). */
export function useUploadVerifactuCredentialMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UploadVerifactuCredentialInput) => {
      const fd = new FormData();
      fd.append('file', input.file);
      fd.append('password', input.password);
      fd.append('environment', input.environment);
      return apiFetch<AeatCredentialMetadata>('/billing/aeat-credentials', {
        method: 'POST',
        formData: fd,
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: verifactuCredentialKey });
      void qc.invalidateQueries({ queryKey: verifactuCredentialHistoryKey });
    },
  });
}

/** DELETE /billing/aeat-credentials/me. Body { reason }. */
export function useRevokeVerifactuCredentialMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { reason: string }) =>
      apiFetch<void>('/billing/aeat-credentials/me', {
        method: 'DELETE',
        json: input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: verifactuCredentialKey });
      void qc.invalidateQueries({ queryKey: verifactuCredentialHistoryKey });
    },
  });
}

/**
 * GET /billing/aeat-credentials/history. Devuelve todas las credenciales
 * (activas + revocadas) del tenant ordenadas por uploadedAt desc. Lo
 * consume el panel desplegable "Histórico de certificados".
 */
export function useVerifactuCredentialHistoryQuery(options: { enabled?: boolean } = {}) {
  return useQuery<AeatCredentialMetadata[]>({
    queryKey: verifactuCredentialHistoryKey,
    queryFn: () => apiFetch<AeatCredentialMetadata[]>('/billing/aeat-credentials/history'),
    staleTime: 30_000,
    enabled: options.enabled ?? true,
  });
}

/**
 * POST /billing/invoices/:id/resend-aeat. Endpoint pendiente de 10A.4.
 * Por ahora la llamada existe para no romper la integración cuando el
 * backend la habilite. Si responde 404 lo mapeamos a un error específico
 * que la UI traduce a "Endpoint pendiente".
 */
export function useResendVerifactuMutation(invoiceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<unknown>(`/billing/invoices/${invoiceId}/resend-aeat`, {
        method: 'POST',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: invoiceKey(invoiceId) });
    },
  });
}
