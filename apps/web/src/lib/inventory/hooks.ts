'use client';

import { useQuery } from '@tanstack/react-query';

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
