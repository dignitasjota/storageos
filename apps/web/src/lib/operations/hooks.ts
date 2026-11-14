import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  CreateIncidentInput,
  CreateTaskInput,
  IncidentCommentDto,
  IncidentCommentInput,
  IncidentDto,
  IncidentRepairTaskDto,
  IncidentReportDto,
  IncidentResponseHours,
  MyTasksCountDto,
  TaskCommentDto,
  TaskCommentInput,
  TaskDto,
  TransitionIncidentInput,
  TransitionTaskInput,
  UpdateIncidentInput,
  UpdateTaskInput,
} from '@storageos/shared';

// ============================================================================
// Tasks
// ============================================================================

export const tasksKey = (params?: Record<string, string | undefined>) =>
  ['tasks', params ?? {}] as const;
export const taskKey = (id: string) => ['tasks', id] as const;
export const taskCommentsKey = (id: string) => ['tasks', id, 'comments'] as const;

export interface TasksFilter {
  status?: string;
  type?: string;
  facilityId?: string;
  unitId?: string;
  assignedToUserId?: string;
}

export function useTasks(params: TasksFilter = {}) {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.type) qs.set('type', params.type);
  if (params.facilityId) qs.set('facilityId', params.facilityId);
  if (params.unitId) qs.set('unitId', params.unitId);
  if (params.assignedToUserId) qs.set('assignedToUserId', params.assignedToUserId);
  return useQuery({
    queryKey: tasksKey(params as Record<string, string | undefined>),
    queryFn: () => apiFetch<TaskDto[]>(`/tasks${qs.toString() ? `?${qs}` : ''}`),
  });
}

export function useTask(id: string | undefined) {
  return useQuery({
    queryKey: id ? taskKey(id) : ['tasks', 'none'],
    queryFn: () => apiFetch<TaskDto>(`/tasks/${id}`),
    enabled: !!id,
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskInput) =>
      apiFetch<TaskDto>('/tasks', { method: 'POST', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export function useUpdateTask(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateTaskInput) =>
      apiFetch<TaskDto>(`/tasks/${id}`, { method: 'PATCH', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export function useTransitionTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: TransitionTaskInput }) =>
      apiFetch<TaskDto>(`/tasks/${args.id}/transition`, {
        method: 'POST',
        json: args.input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export function useUpdateChecklistItem(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { itemId: string; status: 'pending' | 'ok' | 'issue'; note?: string }) =>
      apiFetch<TaskDto>(`/tasks/${taskId}/checklist/${args.itemId}`, {
        method: 'PATCH',
        json: { status: args.status, ...(args.note ? { note: args.note } : {}) },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: ['tasks', taskId] });
    },
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/tasks/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export function useTaskComments(taskId: string | undefined) {
  return useQuery({
    queryKey: taskId ? taskCommentsKey(taskId) : ['tasks', 'none', 'comments'],
    queryFn: () => apiFetch<TaskCommentDto[]>(`/tasks/${taskId}/comments`),
    enabled: !!taskId,
  });
}

export function useAddTaskComment(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TaskCommentInput) =>
      apiFetch<TaskCommentDto>(`/tasks/${taskId}/comments`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: taskCommentsKey(taskId) });
    },
  });
}

// ============================================================================
// Incidents
// ============================================================================

export const incidentsKey = (params?: Record<string, string | undefined>) =>
  ['incidents', params ?? {}] as const;
export const incidentKey = (id: string) => ['incidents', id] as const;
export const incidentCommentsKey = (id: string) => ['incidents', id, 'comments'] as const;

export interface IncidentsFilter {
  status?: string;
  severity?: string;
  facilityId?: string;
  unitId?: string;
  customerId?: string;
  contractId?: string;
  assignedToUserId?: string;
}

export function useIncidents(params: IncidentsFilter = {}) {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.severity) qs.set('severity', params.severity);
  if (params.facilityId) qs.set('facilityId', params.facilityId);
  if (params.unitId) qs.set('unitId', params.unitId);
  if (params.customerId) qs.set('customerId', params.customerId);
  if (params.contractId) qs.set('contractId', params.contractId);
  if (params.assignedToUserId) qs.set('assignedToUserId', params.assignedToUserId);
  return useQuery({
    queryKey: incidentsKey(params as Record<string, string | undefined>),
    queryFn: () => apiFetch<IncidentDto[]>(`/incidents${qs.toString() ? `?${qs}` : ''}`),
  });
}

/** Nº de incidencias abiertas por estado — para los badges del menú (sondea cada 60 s). */
export function useIncidentPendingCounts(enabled = true) {
  return useQuery({
    queryKey: ['incidents', 'pending-counts'] as const,
    queryFn: () =>
      apiFetch<{ reported: number; investigating: number }>('/incidents/pending-counts'),
    enabled,
    refetchInterval: 60_000,
  });
}

export function useIncident(id: string | undefined) {
  return useQuery({
    queryKey: id ? incidentKey(id) : ['incidents', 'none'],
    queryFn: () => apiFetch<IncidentDto>(`/incidents/${id}`),
    enabled: !!id,
  });
}

export function useCreateIncident() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateIncidentInput) =>
      apiFetch<IncidentDto>('/incidents', { method: 'POST', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['incidents'] });
    },
  });
}

export function useUpdateIncident(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateIncidentInput) =>
      apiFetch<IncidentDto>(`/incidents/${id}`, { method: 'PATCH', json: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['incidents'] });
    },
  });
}

export function useTransitionIncident() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: TransitionIncidentInput }) =>
      apiFetch<IncidentDto>(`/incidents/${args.id}/transition`, {
        method: 'POST',
        json: args.input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['incidents'] });
    },
  });
}

export function useDeleteIncident() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/incidents/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['incidents'] });
    },
  });
}

export function useIncidentComments(incidentId: string | undefined) {
  return useQuery({
    queryKey: incidentId ? incidentCommentsKey(incidentId) : ['incidents', 'none', 'comments'],
    queryFn: () => apiFetch<IncidentCommentDto[]>(`/incidents/${incidentId}/comments`),
    enabled: !!incidentId,
  });
}

export function useAddIncidentComment(incidentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: IncidentCommentInput) =>
      apiFetch<IncidentCommentDto>(`/incidents/${incidentId}/comments`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: incidentCommentsKey(incidentId) });
    },
  });
}

/** Las tareas creadas desde una incidencia. */
export function useIncidentRepairTasks(incidentId: string) {
  return useQuery({
    queryKey: ['incidents', incidentId, 'tasks'],
    queryFn: () => apiFetch<IncidentRepairTaskDto[]>(`/incidents/${incidentId}/tasks`),
  });
}

export function useCreateIncidentRepairTask(incidentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<TaskDto>(`/incidents/${incidentId}/task`, { method: 'POST', json: {} }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['incidents'] });
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

/** Responde al inquilino por su chat y lo deja en los comentarios. */
export function useReplyIncident(incidentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      apiFetch<void>(`/incidents/${incidentId}/reply`, { method: 'POST', json: { body } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['incidents'] }),
  });
}

export function useIncidentReport(from: string, to: string) {
  return useQuery({
    queryKey: ['incidents', 'report', from, to],
    queryFn: () => apiFetch<IncidentReportDto>(`/incidents/report?from=${from}&to=${to}`),
  });
}

export function useIncidentResponseHours() {
  return useQuery({
    queryKey: ['incidents', 'settings'],
    queryFn: () => apiFetch<IncidentResponseHours>('/incidents/settings'),
  });
}

export function useUpdateIncidentResponseHours() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (hours: IncidentResponseHours) =>
      apiFetch<IncidentResponseHours>('/incidents/settings', { method: 'PUT', json: hours }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['incidents'] }),
  });
}

/** Mis tareas atrasadas o para hoy (el número del menú). */
export function useMyTasksCount(enabled: boolean) {
  return useQuery({
    queryKey: ['tasks', 'mine-count'],
    queryFn: () => apiFetch<MyTasksCountDto>('/tasks/mine-count'),
    enabled,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
  });
}
