import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';
import { dashboardOccupancyKey } from '../facilities/hooks';

import type {
  CreateUnitCessionInput,
  EndUnitCessionInput,
  UnitCessionCodeDto,
  UnitCessionDto,
  UnitCessionListStatus,
  UpdateUnitCessionInput,
} from '@storageos/shared';

/** Bajo `['units', id]`: lo que refresca el trastero refresca su cesión. */
const cessionKey = (unitId: string) => ['units', unitId, 'cession'] as const;
const cessionHistoryKey = (unitId: string) => ['units', unitId, 'cessions'] as const;

/** La cesión viva del trastero (o null). */
export function useUnitCession(unitId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: unitId ? cessionKey(unitId) : ['units', 'none', 'cession'],
    queryFn: async () =>
      (await apiFetch<{ cession: UnitCessionDto | null }>(`/units/${unitId}/cession`)).cession,
    enabled: !!unitId && enabled,
  });
}

/** Todas las cesiones del trastero (la viva, la primera). */
export function useUnitCessionHistory(unitId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: unitId ? cessionHistoryKey(unitId) : ['units', 'none', 'cessions'],
    queryFn: () => apiFetch<UnitCessionDto[]>(`/units/${unitId}/cessions`),
    enabled: !!unitId && enabled,
  });
}

/** Cesiones vivas del negocio, p. ej. las de un inquilino. */
export function useCessions(
  filters: { status?: UnitCessionListStatus; customerId?: string },
  enabled = true,
) {
  const qs = new URLSearchParams();
  if (filters.status) qs.set('status', filters.status);
  if (filters.customerId) qs.set('customerId', filters.customerId);
  return useQuery({
    queryKey: ['cessions', filters.status ?? null, filters.customerId ?? null] as const,
    queryFn: () => apiFetch<UnitCessionDto[]>(`/cessions${qs.size ? `?${qs.toString()}` : ''}`),
    enabled,
  });
}

function useInvalidateCession() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['units'] });
    void qc.invalidateQueries({ queryKey: ['cessions'] });
    void qc.invalidateQueries({ queryKey: dashboardOccupancyKey });
    void qc.invalidateQueries({ queryKey: ['dashboard', 'today'] });
    void qc.invalidateQueries({ queryKey: ['access'] });
  };
}

export function useCreateUnitCession(unitId: string) {
  const invalidate = useInvalidateCession();
  return useMutation({
    mutationFn: (input: CreateUnitCessionInput) =>
      apiFetch<UnitCessionDto>(`/units/${unitId}/cession`, { method: 'POST', json: input }),
    onSuccess: invalidate,
  });
}

export function useUpdateUnitCession(unitId: string) {
  const invalidate = useInvalidateCession();
  return useMutation({
    mutationFn: (input: UpdateUnitCessionInput) =>
      apiFetch<UnitCessionDto>(`/units/${unitId}/cession`, { method: 'PATCH', json: input }),
    onSuccess: invalidate,
  });
}

export function useEndUnitCession(unitId: string) {
  const invalidate = useInvalidateCession();
  return useMutation({
    mutationFn: (input: EndUnitCessionInput) =>
      apiFetch<UnitCessionDto>(`/units/${unitId}/cession/end`, { method: 'POST', json: input }),
    onSuccess: invalidate,
  });
}

/** Ver el código del acceso (solo el propietario; se pide al pulsar). */
export function useRevealCessionCode(unitId: string) {
  return useMutation({
    mutationFn: () => apiFetch<UnitCessionCodeDto>(`/units/${unitId}/cession/access/code`),
  });
}

export function useRotateCessionCode(unitId: string) {
  const invalidate = useInvalidateCession();
  return useMutation({
    mutationFn: () =>
      apiFetch<UnitCessionCodeDto>(`/units/${unitId}/cession/access/rotate`, { method: 'POST' }),
    onSuccess: invalidate,
  });
}

export function useSetCessionAccess(unitId: string) {
  const invalidate = useInvalidateCession();
  return useMutation({
    mutationFn: (action: 'suspend' | 'resume') =>
      apiFetch<UnitCessionDto>(`/units/${unitId}/cession/access/${action}`, { method: 'POST' }),
    onSuccess: invalidate,
  });
}

/** Crea el acceso de una cesión que no lo tiene (con control de accesos). */
export function useCreateCessionAccess(unitId: string) {
  const invalidate = useInvalidateCession();
  return useMutation({
    mutationFn: () =>
      apiFetch<UnitCessionDto>(`/units/${unitId}/cession/access`, { method: 'POST' }),
    onSuccess: invalidate,
  });
}
