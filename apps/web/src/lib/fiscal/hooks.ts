import { useQuery } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type { Model303Dto, Model347Dto, VatBookDto } from '@storageos/shared';

export function useVatBook(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: ['fiscal', 'vat-book', from, to] as const,
    queryFn: () => apiFetch<VatBookDto>(`/fiscal/vat-book?from=${from}&to=${to}`),
    enabled: enabled && !!from && !!to,
  });
}

export function useModel303(year: number, quarter: number) {
  return useQuery({
    queryKey: ['fiscal', 'model-303', year, quarter] as const,
    queryFn: () => apiFetch<Model303Dto>(`/fiscal/model-303?year=${year}&quarter=${quarter}`),
  });
}

export function useModel347(year: number) {
  return useQuery({
    queryKey: ['fiscal', 'model-347', year] as const,
    queryFn: () => apiFetch<Model347Dto>(`/fiscal/model-347?year=${year}`),
  });
}

/** Descarga un CSV (separador `;`, BOM UTF-8 para Excel español). */
export function downloadCsv(filename: string, rows: (string | number)[][]): void {
  const escape = (v: string | number) => {
    const s = String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = rows.map((r) => r.map(escape).join(';')).join('\n');
  // BOM (\uFEFF) para que Excel detecte UTF-8.
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
