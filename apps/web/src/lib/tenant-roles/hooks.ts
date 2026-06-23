import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  AssignTenantRoleInput,
  CreateTenantRoleInput,
  TenantRoleDto,
  UpdateTenantRoleInput,
} from '@storageos/shared';

export const tenantRolesKey = ['settings', 'roles'] as const;

export function useTenantRoles() {
  return useQuery({
    queryKey: tenantRolesKey,
    queryFn: () => apiFetch<TenantRoleDto[]>('/settings/roles'),
  });
}

export function useCreateTenantRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTenantRoleInput) =>
      apiFetch<TenantRoleDto>('/settings/roles', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: tenantRolesKey }),
  });
}

export function useUpdateTenantRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateTenantRoleInput }) =>
      apiFetch<TenantRoleDto>(`/settings/roles/${id}`, { method: 'PATCH', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: tenantRolesKey }),
  });
}

export function useDeleteTenantRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/settings/roles/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: tenantRolesKey }),
  });
}

export function useAssignTenantRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, input }: { userId: string; input: AssignTenantRoleInput }) =>
      apiFetch<void>(`/settings/users/${userId}/tenant-role`, { method: 'PATCH', json: input }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tenantRolesKey });
    },
  });
}

/** Permisos por local: fija los locales a los que se restringe un usuario. */
export function useSetUserFacilities() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, facilityIds }: { userId: string; facilityIds: string[] }) =>
      apiFetch<void>(`/settings/users/${userId}/facilities`, {
        method: 'PATCH',
        json: { facilityIds },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
    },
  });
}
