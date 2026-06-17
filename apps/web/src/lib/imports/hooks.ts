import { useMutation, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  ImportCustomersCommitDto,
  ImportCustomersPreviewDto,
  ImportDuplicatePolicy,
} from '@storageos/shared';

export function usePreviewCustomerImport() {
  return useMutation({
    mutationFn: (csv: string) =>
      apiFetch<ImportCustomersPreviewDto>('/imports/customers/preview', {
        method: 'POST',
        json: { csv },
      }),
  });
}

export function useCommitCustomerImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { csv: string; onDuplicate: ImportDuplicatePolicy }) =>
      apiFetch<ImportCustomersCommitDto>('/imports/customers/commit', {
        method: 'POST',
        json: args,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}

/** Descarga la plantilla CSV de inquilinos como archivo. */
export async function downloadCustomerImportTemplate(): Promise<void> {
  const { csv } = await apiFetch<{ csv: string }>('/imports/customers/template');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'plantilla-inquilinos.csv';
  a.click();
  URL.revokeObjectURL(url);
}
