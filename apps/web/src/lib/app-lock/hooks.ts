import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type { AppLockStatusDto, AppLockUnlockResultDto } from '@storageos/shared';

export const appLockKey = ['app-lock'] as const;

export function useAppLockStatus(enabled = true) {
  return useQuery({
    queryKey: appLockKey,
    queryFn: () => apiFetch<AppLockStatusDto>('/me/app-lock'),
    enabled,
    staleTime: 60_000,
  });
}

export function useSetAppPin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pin: string) =>
      apiFetch<void>('/me/app-lock/pin', { method: 'PUT', json: { pin } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: appLockKey }),
  });
}

export function useRemoveAppPin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>('/me/app-lock/pin', { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: appLockKey }),
  });
}

/** Activa Face ID / huella en este dispositivo (crea una llave de acceso). */
export function useAddPasskey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (label: string) => {
      const optionsJSON = await apiFetch<PublicKeyCredentialCreationOptionsJSON>(
        '/me/app-lock/passkeys/options',
        { method: 'POST' },
      );
      const response = await startRegistration({ optionsJSON });
      await apiFetch<void>('/me/app-lock/passkeys', { method: 'POST', json: { response, label } });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: appLockKey }),
  });
}

export function useRemovePasskey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/me/app-lock/passkeys/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: appLockKey }),
  });
}

export async function unlockWithPasskey(): Promise<AppLockUnlockResultDto> {
  const optionsJSON = await apiFetch<PublicKeyCredentialRequestOptionsJSON>(
    '/me/app-lock/unlock/options',
    { method: 'POST' },
  );
  const response = await startAuthentication({ optionsJSON });
  return apiFetch<AppLockUnlockResultDto>('/me/app-lock/unlock/passkey', {
    method: 'POST',
    json: { response },
  });
}

export function unlockWithPin(pin: string): Promise<AppLockUnlockResultDto> {
  return apiFetch<AppLockUnlockResultDto>('/me/app-lock/unlock/pin', {
    method: 'POST',
    json: { pin },
  });
}
