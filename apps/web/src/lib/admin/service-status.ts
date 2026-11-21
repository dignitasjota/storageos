import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { adminApiFetch } from './api';

import type { AdminServiceStatusDto, UpdateServiceStatusInput } from '@storageos/shared';

const key = ['admin', 'service-status'] as const;

/** Estado del servicio que ven los negocios en Soporte, con el historial de incidencias. */
export function useAdminServiceStatus() {
  return useQuery({
    queryKey: key,
    queryFn: () => adminApiFetch<AdminServiceStatusDto>('/admin/service-status'),
  });
}

export function useUpdateServiceStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateServiceStatusInput) =>
      adminApiFetch<AdminServiceStatusDto>('/admin/service-status', {
        method: 'PUT',
        json: input,
      }),
    onSuccess: (data) => qc.setQueryData(key, data),
  });
}
