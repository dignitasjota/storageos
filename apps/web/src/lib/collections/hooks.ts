import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  CancelCaseInput,
  CollectionsSettingsResponse,
  CompleteDisposalInput,
  DelinquencyCaseDetailDto,
  DelinquencyCaseDto,
  DelinquencyCaseStatus,
  DelinquencyRequirementPdfDto,
  OpenCaseInput,
  OverlockCaseInput,
  RegisterCaseFileInput,
  RequestCaseFileUploadInput,
  SendNoticeInput,
  StartDisposalInput,
  UpdateCollectionsSettingsInput,
} from '@storageos/shared';

const key = ['collections'] as const;

export function useCollectionsCases(status?: DelinquencyCaseStatus) {
  return useQuery({
    queryKey: [...key, 'list', status ?? 'all'] as const,
    queryFn: () =>
      apiFetch<DelinquencyCaseDto[]>(`/collections${status ? `?status=${status}` : ''}`),
  });
}

export function useCollectionsCase(id: string) {
  return useQuery({
    queryKey: [...key, 'detail', id] as const,
    queryFn: () => apiFetch<DelinquencyCaseDetailDto>(`/collections/${id}`),
    enabled: Boolean(id),
  });
}

export function useCollectionsSettings() {
  return useQuery({
    queryKey: [...key, 'settings'] as const,
    queryFn: () => apiFetch<CollectionsSettingsResponse>('/collections/settings'),
  });
}

export function useUpdateCollectionsSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateCollectionsSettingsInput) =>
      apiFetch<CollectionsSettingsResponse>('/collections/settings', {
        method: 'PUT',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...key, 'settings'] }),
  });
}

export function useOpenCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: OpenCaseInput) =>
      apiFetch<DelinquencyCaseDto>('/collections', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}

/** Acciones de la máquina de estados sobre un expediente. */
type CaseActionBody =
  | { action: 'overlock'; input: OverlockCaseInput }
  | { action: 'notice'; input: SendNoticeInput }
  | { action: 'resolution-pending'; input?: undefined }
  | { action: 'disposal'; input: StartDisposalInput }
  | { action: 'complete-disposal'; input: CompleteDisposalInput }
  | { action: 'cancel'; input: CancelCaseInput }
  | { action: 'note'; input: { note: string } };

export function useCaseAction(caseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CaseActionBody) =>
      apiFetch(`/collections/${caseId}/${body.action}`, {
        method: 'POST',
        json: body.input ?? {},
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...key, 'detail', caseId] });
      void qc.invalidateQueries({ queryKey: [...key, 'list'] });
    },
  });
}

/** Genera el requerimiento fehaciente (PDF) y refresca las evidencias del caso. */
export function useGenerateRequirementPdf(caseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<DelinquencyRequirementPdfDto>(`/collections/${caseId}/requirement-pdf`, {
        method: 'POST',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...key, 'detail', caseId] }),
  });
}

/** Sube una evidencia (presigned PUT) y la registra. */
export function useUploadCaseFile(caseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      file,
      kind,
    }: {
      file: File;
      kind: RequestCaseFileUploadInput['kind'];
    }) => {
      const { uploadUrl, objectKey } = await apiFetch<{ uploadUrl: string; objectKey: string }>(
        `/collections/${caseId}/files/upload-url`,
        { method: 'POST', json: { kind, contentType: file.type || 'application/octet-stream' } },
      );
      const put = await fetch(uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
      });
      if (!put.ok) throw new Error('upload_failed');
      const body: RegisterCaseFileInput = { kind, objectKey, contentType: file.type };
      await apiFetch(`/collections/${caseId}/files`, { method: 'POST', json: body });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [...key, 'detail', caseId] }),
  });
}
