import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  AccessReportDto,
  BulkAssignTasksResultDto,
  ContractChecklistDto,
  CustomerAuthorizedPersonDto,
  CustomerAuthorizedPersonInput,
  DoorViewDto,
  IncidentContextDto,
  MoveFromUnitChangeInput,
  ReservationDto,
  TaskAutoRules,
  UnitChangeRequestDto,
  VisitorPinDto,
  VisitorPinInput,
} from '@storageos/shared';

/** Entrada y salida del contrato. */
export function useContractChecklist(contractId: string | undefined) {
  return useQuery({
    queryKey: ['contracts', contractId, 'checklist'],
    queryFn: () => apiFetch<ContractChecklistDto>(`/contracts/${contractId}/checklist`),
    enabled: !!contractId,
  });
}

/** Trasladar desde una solicitud de cambio de trastero. */
export function useMoveFromUnitChange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: MoveFromUnitChangeInput & { id: string }) =>
      apiFetch<UnitChangeRequestDto>(`/unit-change-requests/${id}/move`, {
        method: 'POST',
        json: body,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['unit-change-requests'] });
      void qc.invalidateQueries({ queryKey: ['contracts'] });
      void qc.invalidateQueries({ queryKey: ['units'] });
    },
  });
}

/** Asignar varias tareas. */
export function useBulkAssignTasks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { taskIds: string[]; assignedToUserId: string | null }) =>
      apiFetch<BulkAssignTasksResultDto>('/tasks/bulk-assign', { method: 'POST', json: body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tasks'] }),
  });
}

/** Reglas de tareas automáticas. */
export function useTaskAutoRules() {
  return useQuery({
    queryKey: ['tasks', 'auto-rules'],
    queryFn: () => apiFetch<TaskAutoRules>('/tasks/auto-rules'),
  });
}

export function useUpdateTaskAutoRules() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TaskAutoRules) =>
      apiFetch<TaskAutoRules>('/tasks/auto-rules', { method: 'PUT', json: body }),
    onSuccess: (data) => qc.setQueryData(['tasks', 'auto-rules'], data),
  });
}

/** Lo que rodea a una incidencia. */
export function useIncidentContext(id: string | undefined) {
  return useQuery({
    queryKey: ['incidents', id, 'context'],
    queryFn: () => apiFetch<IncidentContextDto>(`/incidents/${id}/context`),
    enabled: !!id,
  });
}

/** Señal de una reserva. */
export function useReservationDepositInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<ReservationDto>(`/reservations/${id}/deposit-invoice`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reservations'] });
      void qc.invalidateQueries({ queryKey: ['invoices'] });
    },
  });
}

/** Personas autorizadas por el inquilino. */
export function useAuthorizedPersons(customerId: string | undefined) {
  return useQuery({
    queryKey: ['customers', customerId, 'authorized-persons'],
    queryFn: () =>
      apiFetch<CustomerAuthorizedPersonDto[]>(`/customers/${customerId}/authorized-persons`),
    enabled: !!customerId,
  });
}

export function useSaveAuthorizedPerson(customerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: CustomerAuthorizedPersonInput & { id?: string }) =>
      apiFetch<CustomerAuthorizedPersonDto>(
        id
          ? `/customers/${customerId}/authorized-persons/${id}`
          : `/customers/${customerId}/authorized-persons`,
        { method: id ? 'PATCH' : 'POST', json: body },
      ),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['customers', customerId, 'authorized-persons'] }),
  });
}

export function useDeleteAuthorizedPerson(customerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/customers/${customerId}/authorized-persons/${id}`, { method: 'DELETE' }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['customers', customerId, 'authorized-persons'] }),
  });
}

/** Informe de accesos. */
export function useAccessReport(days: number, facilityId?: string | null) {
  const qs = new URLSearchParams({ days: String(days) });
  if (facilityId) qs.set('facilityId', facilityId);
  return useQuery({
    queryKey: ['access', 'report', days, facilityId ?? null],
    queryFn: () => apiFetch<AccessReportDto>(`/access/logs/report?${qs}`),
  });
}

/** Vista de la puerta del local. */
export function useDoorView(facilityId: string | null | undefined) {
  return useQuery({
    queryKey: ['access', 'door', facilityId],
    queryFn: () => apiFetch<DoorViewDto>(`/access/door?facilityId=${facilityId}`),
    enabled: !!facilityId,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useVisitorPin() {
  return useMutation({
    mutationFn: (body: VisitorPinInput) =>
      apiFetch<VisitorPinDto>('/access/door/visitor-pin', { method: 'POST', json: body }),
  });
}
