'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  TenantBrandingResponse,
  TenantFaviconUploadDto,
  UpdateTenantBrandingInput,
} from '@storageos/shared';

import { apiFetch } from '@/lib/auth/api';

const brandingKey = ['settings', 'tenant', 'branding'] as const;

export function useTenantBranding() {
  return useQuery({
    queryKey: brandingKey,
    queryFn: () => apiFetch<TenantBrandingResponse>('/settings/tenant/branding'),
  });
}

export function useUpdateTenantBranding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateTenantBrandingInput) =>
      apiFetch<TenantBrandingResponse>('/settings/tenant/branding', {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: brandingKey }),
  });
}

/** Sube el favicon (URL firmada → PUT directo al bucket → fijar la clave). */
export function useUploadTenantFavicon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const mimeType =
        file.type === 'image/x-icon' || file.name.endsWith('.ico') ? 'image/x-icon' : 'image/png';
      const up = await apiFetch<TenantFaviconUploadDto>(
        '/settings/tenant/branding/favicon-upload-url',
        {
          method: 'POST',
          json: { mimeType },
        },
      );
      const put = await fetch(up.uploadUrl, {
        method: 'PUT',
        headers: up.requiredHeaders,
        body: file,
      });
      if (!put.ok) throw new Error('upload_failed');
      return apiFetch<TenantBrandingResponse>('/settings/tenant/branding/favicon', {
        method: 'PUT',
        json: { key: up.key },
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: brandingKey }),
  });
}

export function useRemoveTenantFavicon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<TenantBrandingResponse>('/settings/tenant/branding/favicon', {
        method: 'PUT',
        json: { key: null },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: brandingKey }),
  });
}

/** Sube el logo (URL firmada → PUT directo al bucket → fijar la clave). */
export function useUploadTenantLogo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const mimeType = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
      const up = await apiFetch<TenantFaviconUploadDto>(
        '/settings/tenant/branding/logo-upload-url',
        { method: 'POST', json: { mimeType } },
      );
      const put = await fetch(up.uploadUrl, {
        method: 'PUT',
        headers: up.requiredHeaders,
        body: file,
      });
      if (!put.ok) throw new Error('upload_failed');
      return apiFetch<TenantBrandingResponse>('/settings/tenant/branding/logo', {
        method: 'PUT',
        json: { key: up.key },
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: brandingKey }),
  });
}

export function useRemoveTenantLogo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<TenantBrandingResponse>('/settings/tenant/branding/logo', {
        method: 'PUT',
        json: { key: null },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: brandingKey }),
  });
}
