import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';
import { compressImage } from '../images/compress';

import type {
  BulkCreateUnitsInput,
  BulkCreateUnitsResultDto,
  BulkUnitsActionInput,
  BulkUnitsResultDto,
  CreateFacilityDocumentInput,
  FacilityDocumentDto,
  FacilityDocumentKind,
  FacilityDocumentUploadDto,
  FacilityImageUploadResponseDto,
  FacilitySummaryDto,
  FloorHoldDto,
  FloorOccupantDto,
  SaveUnitViewInput,
  UnitDto,
  UnitInsightsDto,
  UnitSavedViewDto,
  UnitsOverviewDto,
  UpdateFacilityDocumentInput,
} from '@storageos/shared';

/** Refresca todo lo que depende de los trasteros. */
function invalidateUnits(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['units'] });
  void qc.invalidateQueries({ queryKey: ['facilities'] });
  void qc.invalidateQueries({ queryKey: ['dashboard'] });
  void qc.invalidateQueries({ queryKey: ['inventory'] });
}

export function useUnitInsights(unitId: string | undefined) {
  return useQuery({
    queryKey: ['units', unitId, 'insights'],
    queryFn: () => apiFetch<UnitInsightsDto>(`/units/${unitId}/insights`),
    enabled: !!unitId,
  });
}

/** La lista de Trasteros: cada uno con su inquilino, cuota, deuda y días libre. */
export function useUnitsOverview(facilityId: string | undefined) {
  return useQuery({
    queryKey: ['units', 'overview', facilityId ?? 'all'],
    queryFn: () =>
      apiFetch<UnitsOverviewDto>(`/units/overview${facilityId ? `?facilityId=${facilityId}` : ''}`),
    staleTime: 15_000,
  });
}

const unitViewsKey = ['units', 'views'] as const;

export function useUnitViews() {
  return useQuery({
    queryKey: unitViewsKey,
    queryFn: () => apiFetch<UnitSavedViewDto[]>('/units/views'),
  });
}

export function useSaveUnitView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveUnitViewInput) =>
      apiFetch<UnitSavedViewDto>('/units/views', { method: 'POST', json: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: unitViewsKey }),
  });
}

export function useDeleteUnitView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/units/views/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: unitViewsKey }),
  });
}

/** Sube una foto del trastero (comprimida en el navegador) y devuelve su clave. */
export async function uploadUnitImage(unitId: string, file: File): Promise<string> {
  const compressed = await compressImage(file);
  const presign = await apiFetch<FacilityImageUploadResponseDto>(
    `/units/${unitId}/images/upload-url`,
    { method: 'POST', json: { mimeType: compressed.type, sizeBytes: compressed.size } },
  );
  const put = await fetch(presign.uploadUrl, {
    method: 'PUT',
    headers: presign.requiredHeaders,
    body: compressed,
  });
  if (!put.ok) throw new Error('No se pudo subir la foto');
  return presign.key;
}

export function useSetUnitImages() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; images: string[] }) =>
      apiFetch<UnitDto>(`/units/${args.id}/images`, {
        method: 'PUT',
        json: { images: args.images },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['units'] }),
  });
}

export function useBulkUnits() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BulkUnitsActionInput) =>
      apiFetch<BulkUnitsResultDto>('/units/bulk', { method: 'POST', json: input }),
    onSuccess: () => invalidateUnits(qc),
  });
}

export function useBulkCreateUnits() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BulkCreateUnitsInput) =>
      apiFetch<BulkCreateUnitsResultDto>('/units/bulk-create', { method: 'POST', json: input }),
    onSuccess: () => invalidateUnits(qc),
  });
}

export function useFloorOccupants(floorId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['facilities', 'floors', floorId, 'occupants'],
    queryFn: () => apiFetch<FloorOccupantDto[]>(`/floors/${floorId}/occupants`),
    enabled: !!floorId && enabled,
  });
}

export function useFloorHolds(floorId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['facilities', 'floors', floorId, 'holds'],
    queryFn: () => apiFetch<FloorHoldDto[]>(`/floors/${floorId}/holds`),
    enabled: !!floorId && enabled,
  });
}

export function useFacilitySummary() {
  return useQuery({
    queryKey: ['facilities', 'summary'],
    queryFn: () => apiFetch<FacilitySummaryDto[]>('/facilities/summary'),
  });
}

// --- Documentos del local ---------------------------------------------------

const docsKey = (facilityId: string) => ['facilities', facilityId, 'documents'] as const;

export function useFacilityDocuments(facilityId: string) {
  return useQuery({
    queryKey: docsKey(facilityId),
    queryFn: () => apiFetch<FacilityDocumentDto[]>(`/facilities/${facilityId}/documents`),
  });
}

export function useUploadFacilityDocument(facilityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      file: File;
      kind: FacilityDocumentKind;
      name: string;
      expiresOn?: string;
      notes?: string;
    }) => {
      const mimeType = args.file.type as CreateFacilityDocumentInput['mimeType'];
      const presign = await apiFetch<FacilityDocumentUploadDto>(
        `/facilities/${facilityId}/documents/upload-url`,
        { method: 'POST', json: { mimeType, sizeBytes: args.file.size } },
      );
      const put = await fetch(presign.uploadUrl, {
        method: 'PUT',
        headers: presign.requiredHeaders,
        body: args.file,
      });
      if (!put.ok) throw new Error('No se pudo subir el fichero');
      return apiFetch<FacilityDocumentDto>(`/facilities/${facilityId}/documents`, {
        method: 'POST',
        json: {
          key: presign.key,
          kind: args.kind,
          name: args.name,
          mimeType,
          sizeBytes: args.file.size,
          ...(args.expiresOn ? { expiresOn: args.expiresOn } : {}),
          ...(args.notes ? { notes: args.notes } : {}),
        } satisfies CreateFacilityDocumentInput,
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: docsKey(facilityId) });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useUpdateFacilityDocument(facilityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: UpdateFacilityDocumentInput }) =>
      apiFetch<FacilityDocumentDto>(`/facilities/${facilityId}/documents/${args.id}`, {
        method: 'PATCH',
        json: args.input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: docsKey(facilityId) });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useDeleteFacilityDocument(facilityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/facilities/${facilityId}/documents/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: docsKey(facilityId) });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export async function openFacilityDocument(facilityId: string, id: string): Promise<void> {
  const { url } = await apiFetch<{ url: string }>(
    `/facilities/${facilityId}/documents/${id}/download`,
  );
  window.open(url, '_blank', 'noopener');
}
