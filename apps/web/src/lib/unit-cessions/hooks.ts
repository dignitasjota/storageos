import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';
import { dashboardOccupancyKey } from '../facilities/hooks';

import type {
  CreateUnitCessionCodeInput,
  CreateUnitCessionInput,
  EndUnitCessionInput,
  PageDto,
  SnoozeUnitCessionInput,
  UnitCessionCodeDto,
  UnitCessionDto,
  UnitCessionListStatus,
  UnitCessionNewCodeDto,
  UnitCessionToContractDto,
  UpdateUnitCessionCodeInput,
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

/** Página «Cesiones»: por estado, local y búsqueda, con «Cargar más». */
export function useCessionsPage(
  filters: { status: UnitCessionListStatus; search?: string; facilityId?: string },
  enabled = true,
) {
  return useInfiniteQuery({
    queryKey: [
      'cessions',
      'page',
      filters.status,
      filters.search ?? '',
      filters.facilityId ?? null,
    ] as const,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ status: filters.status, limit: '50' });
      if (filters.search) qs.set('search', filters.search);
      if (filters.facilityId) qs.set('facilityId', filters.facilityId);
      if (pageParam) qs.set('cursor', pageParam);
      return apiFetch<PageDto<UnitCessionDto>>(`/cessions/page?${qs.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

/** ¿Hay alguna cesión (viva o pasada)? Para el menú sin la función activada. */
export function useHasAnyCession(enabled: boolean) {
  return useQuery({
    queryKey: ['cessions', 'page', 'any'] as const,
    queryFn: () => apiFetch<PageDto<UnitCessionDto>>('/cessions/page?status=all&limit=1'),
    select: (page) => page.items.length > 0,
    enabled,
    staleTime: 5 * 60_000,
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

/** Amplía N meses la cesión de un trastero (desde «Hoy» o la página «Cesiones»). */
export function useExtendCession() {
  const invalidate = useInvalidateCession();
  return useMutation({
    mutationFn: ({ unitId, months }: { unitId: string; months: number }) =>
      apiFetch<UnitCessionDto>(`/units/${unitId}/cession`, {
        method: 'PATCH',
        json: { months } satisfies UpdateUnitCessionInput,
      }),
    onSuccess: invalidate,
  });
}

/** Pospone el aviso de una cesión vencida. */
export function useSnoozeCession() {
  const invalidate = useInvalidateCession();
  return useMutation({
    mutationFn: ({ unitId, days }: { unitId: string } & SnoozeUnitCessionInput) =>
      apiFetch<UnitCessionDto>(`/units/${unitId}/cession/snooze`, {
        method: 'POST',
        json: { days },
      }),
    onSuccess: invalidate,
  });
}

/** Termina la cesión dejando el trastero disponible y da el asistente de contrato. */
export function useCessionToContract(unitId: string) {
  const invalidate = useInvalidateCession();
  return useMutation({
    mutationFn: () =>
      apiFetch<UnitCessionToContractDto>(`/units/${unitId}/cession/to-contract`, {
        method: 'POST',
      }),
    onSuccess: invalidate,
  });
}

/** Ruta de un código concreto de la cesión (sin id, el principal). */
function codePath(unitId: string, credentialId: string | null | undefined, action: string) {
  return credentialId
    ? `/units/${unitId}/cession/access/codes/${credentialId}${action}`
    : `/units/${unitId}/cession/access${action}`;
}

/** Ver el código de un código concreto (sin id, el principal). */
export function useRevealCessionCodeOf(unitId: string) {
  return useMutation({
    mutationFn: (credentialId: string | null) =>
      apiFetch<UnitCessionCodeDto>(codePath(unitId, credentialId, '/code')),
  });
}

export function useRotateCessionCodeOf(unitId: string) {
  const invalidate = useInvalidateCession();
  return useMutation({
    mutationFn: (credentialId: string | null) =>
      apiFetch<UnitCessionCodeDto>(codePath(unitId, credentialId, '/rotate'), {
        method: 'POST',
      }),
    onSuccess: invalidate,
  });
}

export function useSetCessionCodeAccess(unitId: string) {
  const invalidate = useInvalidateCession();
  return useMutation({
    mutationFn: ({
      credentialId,
      action,
    }: {
      credentialId: string | null;
      action: 'suspend' | 'resume';
    }) =>
      apiFetch<UnitCessionDto>(codePath(unitId, credentialId, `/${action}`), { method: 'POST' }),
    onSuccess: invalidate,
  });
}

/** Acceso 24 h o nombre de un código. */
export function useUpdateCessionCode(unitId: string) {
  const invalidate = useInvalidateCession();
  return useMutation({
    mutationFn: ({
      credentialId,
      input,
    }: {
      credentialId: string | null;
      input: UpdateUnitCessionCodeInput;
    }) =>
      apiFetch<UnitCessionDto>(codePath(unitId, credentialId, ''), {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: invalidate,
  });
}

/** Otro código para la misma cesión. */
export function useCreateCessionCode(unitId: string) {
  const invalidate = useInvalidateCession();
  return useMutation({
    mutationFn: (input: CreateUnitCessionCodeInput) =>
      apiFetch<UnitCessionNewCodeDto>(`/units/${unitId}/cession/access/codes`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: invalidate,
  });
}

export function useRemoveCessionCode(unitId: string) {
  const invalidate = useInvalidateCession();
  return useMutation({
    mutationFn: (credentialId: string) =>
      apiFetch<UnitCessionDto>(`/units/${unitId}/cession/access/codes/${credentialId}`, {
        method: 'DELETE',
      }),
    onSuccess: invalidate,
  });
}
