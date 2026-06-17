import { useMutation, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type { ImportCommitDto, ImportDuplicatePolicy, ImportPreviewDto } from '@storageos/shared';

export type ImportEntity = 'customers' | 'units' | 'contracts';

/** Query keys a invalidar tras importar cada entidad. */
const INVALIDATE_KEYS: Record<ImportEntity, string[]> = {
  customers: ['customers'],
  units: ['units'],
  contracts: ['contracts'],
};

export function useImportPreview(entity: ImportEntity) {
  return useMutation({
    mutationFn: (csv: string) =>
      apiFetch<ImportPreviewDto>(`/imports/${entity}/preview`, {
        method: 'POST',
        json: { csv },
      }),
  });
}

export function useImportCommit(entity: ImportEntity) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { csv: string; onDuplicate: ImportDuplicatePolicy }) =>
      apiFetch<ImportCommitDto>(`/imports/${entity}/commit`, {
        method: 'POST',
        json: args,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: INVALIDATE_KEYS[entity] });
    },
  });
}

/** Descarga la plantilla CSV de la entidad como archivo. */
export async function downloadImportTemplate(
  entity: ImportEntity,
  filename: string,
): Promise<void> {
  const { csv } = await apiFetch<{ csv: string }>(`/imports/${entity}/template`);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
