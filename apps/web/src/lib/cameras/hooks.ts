import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  CameraDeviceDto,
  CameraDeviceWithTokenDto,
  CameraEventDto,
  CreateCameraDeviceInput,
  CreateIncidentFromEventInput,
  IncidentDto,
} from '@storageos/shared';

const devicesKey = (facilityId?: string) => ['cameras', 'devices', facilityId ?? 'all'] as const;
const eventsKey = (facilityId?: string, kind?: string) =>
  ['cameras', 'events', facilityId ?? 'all', kind ?? 'all'] as const;

export function useCameraDevices(facilityId?: string) {
  return useQuery({
    queryKey: devicesKey(facilityId),
    queryFn: () =>
      apiFetch<CameraDeviceDto[]>(
        `/cameras/devices${facilityId ? `?facilityId=${facilityId}` : ''}`,
      ),
  });
}

export function useCameraEvents(facilityId?: string, kind?: string) {
  return useQuery({
    queryKey: eventsKey(facilityId, kind),
    queryFn: () => {
      const params = new URLSearchParams();
      if (facilityId) params.set('facilityId', facilityId);
      if (kind) params.set('kind', kind);
      const qs = params.toString();
      return apiFetch<CameraEventDto[]>(`/cameras/events${qs ? `?${qs}` : ''}`);
    },
    refetchInterval: 30_000,
  });
}

export function useCreateCameraDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCameraDeviceInput) =>
      apiFetch<CameraDeviceWithTokenDto>('/cameras/devices', { method: 'POST', json: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['cameras', 'devices'] }),
  });
}

export function useRegenerateCameraToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<CameraDeviceWithTokenDto>(`/cameras/devices/${id}/regenerate-token`, {
        method: 'POST',
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['cameras', 'devices'] }),
  });
}

export function useDeleteCameraDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/cameras/devices/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['cameras', 'devices'] }),
  });
}

/** Eventos de cámara vinculados a una incidencia (para la ficha de incidencia). */
export function useCameraEventsByIncident(incidentId: string | null) {
  return useQuery({
    queryKey: ['cameras', 'events', 'incident', incidentId],
    queryFn: () => apiFetch<CameraEventDto[]>(`/cameras/events?incidentId=${incidentId}`),
    enabled: !!incidentId,
  });
}

/** Crea una incidencia a partir de un evento de alarma/cámara y lo vincula. */
export function useCreateIncidentFromEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ eventId, input }: { eventId: string; input: CreateIncidentFromEventInput }) =>
      apiFetch<IncidentDto>(`/cameras/events/${eventId}/incident`, { method: 'POST', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['cameras', 'events'] });
      void qc.invalidateQueries({ queryKey: ['incidents'] });
    },
  });
}
