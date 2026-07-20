import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  NightPassListDto,
  AccessCredentialDto,
  AccessCredentialStatusValue,
  AccessCredentialWithSecretDto,
  AccessDeviceDto,
  AccessDeviceTypeValue,
  AccessDeviceWithKeyDto,
  AccessLogDto,
  AccessMethodValue,
  AccessResultValue,
  CreateCredentialInput,
  CreateFacialCredentialInput,
  CreateDeviceInput,
  RotateCredentialInput,
  SuspendCredentialInput,
  UpdateCredentialInput,
  UpdateDeviceInput,
} from '@storageos/shared';

// ----------------- Keys -----------------
export const credentialsKey = (params?: Record<string, string | undefined>) =>
  ['access', 'credentials', params ?? {}] as const;
export const credentialKey = (id: string) => ['access', 'credentials', id] as const;
export const devicesKey = (params?: Record<string, string | undefined>) =>
  ['access', 'devices', params ?? {}] as const;
export const deviceKey = (id: string) => ['access', 'devices', id] as const;
export const accessLogsKey = (params?: Record<string, string | undefined>) =>
  ['access', 'logs', params ?? {}] as const;

function toQuery(params?: Record<string, string | undefined>): string {
  if (!params) return '';
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) qs.set(k, v);
  }
  const str = qs.toString();
  return str ? `?${str}` : '';
}

// ============================================================================
// Credentials
// ============================================================================

export function useCredentials(params?: {
  status?: AccessCredentialStatusValue;
  customerId?: string;
  method?: AccessMethodValue;
}) {
  const flat: Record<string, string | undefined> = {
    status: params?.status,
    customerId: params?.customerId,
    method: params?.method,
  };
  return useQuery({
    queryKey: credentialsKey(flat),
    queryFn: () => apiFetch<AccessCredentialDto[]>(`/access/credentials${toQuery(flat)}`),
  });
}

export function useCredential(id: string | undefined) {
  return useQuery({
    queryKey: id ? credentialKey(id) : ['access', 'credentials', 'none'],
    queryFn: () => apiFetch<AccessCredentialDto>(`/access/credentials/${id}`),
    enabled: !!id,
  });
}

export function useCreateCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCredentialInput) =>
      apiFetch<AccessCredentialWithSecretDto>('/access/credentials', {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['access', 'credentials'] }),
  });
}

export function useCreateFacialCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateFacialCredentialInput) =>
      apiFetch<AccessCredentialDto>('/access/credentials/face', {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['access', 'credentials'] }),
  });
}

export function useUpdateCredential(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateCredentialInput) =>
      apiFetch<AccessCredentialDto>(`/access/credentials/${id}`, {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['access', 'credentials'] }),
  });
}

export function useRotateCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: RotateCredentialInput }) =>
      apiFetch<AccessCredentialWithSecretDto>(`/access/credentials/${args.id}/rotate`, {
        method: 'POST',
        json: args.input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['access', 'credentials'] }),
  });
}

export function useSuspendCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: SuspendCredentialInput }) =>
      apiFetch<AccessCredentialDto>(`/access/credentials/${args.id}/suspend`, {
        method: 'POST',
        json: args.input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['access', 'credentials'] }),
  });
}

export function useResumeCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<AccessCredentialDto>(`/access/credentials/${id}/resume`, {
        method: 'POST',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['access', 'credentials'] }),
  });
}

export function useRevokeCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<AccessCredentialDto>(`/access/credentials/${id}/revoke`, {
        method: 'POST',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['access', 'credentials'] }),
  });
}

// ============================================================================
// Devices
// ============================================================================

export function useDevices(params?: { facilityId?: string; type?: AccessDeviceTypeValue }) {
  const flat: Record<string, string | undefined> = {
    facilityId: params?.facilityId,
    type: params?.type,
  };
  return useQuery({
    queryKey: devicesKey(flat),
    queryFn: () => apiFetch<AccessDeviceDto[]>(`/access/devices${toQuery(flat)}`),
  });
}

export function useDevice(id: string | undefined) {
  return useQuery({
    queryKey: id ? deviceKey(id) : ['access', 'devices', 'none'],
    queryFn: () => apiFetch<AccessDeviceDto>(`/access/devices/${id}`),
    enabled: !!id,
  });
}

export function useCreateDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDeviceInput) =>
      apiFetch<AccessDeviceWithKeyDto>('/access/devices', {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['access', 'devices'] }),
  });
}

export function useUpdateDevice(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateDeviceInput) =>
      apiFetch<AccessDeviceDto>(`/access/devices/${id}`, {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['access', 'devices'] }),
  });
}

export function useRegenerateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<AccessDeviceWithKeyDto>(`/access/devices/${id}/regenerate-key`, {
        method: 'POST',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['access', 'devices'] }),
  });
}

export function useDeleteDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/access/devices/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['access', 'devices'] }),
  });
}

export function usePingDevice() {
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ ok: boolean; isOnline: boolean; lastSeenAt: string | null }>(
        `/access/devices/${id}/ping`,
        { method: 'POST' },
      ),
  });
}

/** Apertura remota disparada por el staff (server → controlador). */
export function useOpenDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ dispatched: boolean; message?: string }>(`/access/devices/${id}/open`, {
        method: 'POST',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['access', 'devices'] }),
  });
}

/** Cierre remoto / lockdown disparado por el staff. */
export function useCloseDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ dispatched: boolean; message?: string }>(`/access/devices/${id}/close`, {
        method: 'POST',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['access', 'devices'] }),
  });
}

// ============================================================================
// Access logs
// ============================================================================

export function useAccessLogs(params?: {
  customerId?: string;
  deviceId?: string;
  result?: AccessResultValue;
  from?: string;
  to?: string;
}) {
  const flat: Record<string, string | undefined> = {
    customerId: params?.customerId,
    deviceId: params?.deviceId,
    result: params?.result,
    from: params?.from,
    to: params?.to,
  };
  return useQuery({
    queryKey: accessLogsKey(flat),
    queryFn: () => apiFetch<AccessLogDto[]>(`/access/logs${toQuery(flat)}`),
  });
}

/** Pases nocturnos del tenant + ingresos (subpágina de accesos). */
export function useNightPasses() {
  return useQuery({
    queryKey: ['access', 'night-passes'] as const,
    queryFn: () => apiFetch<NightPassListDto>('/access/credentials/night-passes'),
  });
}
