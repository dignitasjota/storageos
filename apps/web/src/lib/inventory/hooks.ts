'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { InventoryIssueDto } from '@storageos/shared';

import { apiFetch } from '@/lib/auth/api';

export const inventoryIssuesKey = ['inventory', 'issues'] as const;

export function useInventoryIssues(enabled = true) {
  return useQuery({
    queryKey: inventoryIssuesKey,
    queryFn: () => apiFetch<InventoryIssueDto[]>('/inventory/issues'),
    enabled,
    staleTime: 60_000,
  });
}

/** Pone a un trastero descuadrado el estado que le corresponde (también «ocupado»). */
export function useFixInventoryIssue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (unitId: string) =>
      apiFetch<InventoryIssueDto>(`/inventory/issues/${unitId}/fix`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: inventoryIssuesKey });
      void qc.invalidateQueries({ queryKey: ['units'] });
      void qc.invalidateQueries({ queryKey: ['facilities'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}
