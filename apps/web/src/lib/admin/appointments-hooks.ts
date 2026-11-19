'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { adminApiFetch } from './api';

import type {
  AdminCreateSalesAppointmentInput,
  CreateSalesAppointmentInput,
  SalesAppointmentDto,
  UpdateSalesAppointmentInput,
} from '@storageos/shared';

/**
 * Citas de los comerciales: las del propio comercial (`/admin/sales/...`) y
 * las de todos para la dirección (`/admin/sales-team/appointments`).
 */

export type AppointmentScope = 'upcoming' | 'past' | 'all';

const ROOT = ['admin', 'appointments'] as const;

function qs(q: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ROOT });
    // «Hoy» del comercial lleva sus citas de hoy.
    void qc.invalidateQueries({ queryKey: ['admin', 'sales'] });
    // Poner una cita puede pasar el lead a la cartera del comercial.
    void qc.invalidateQueries({ queryKey: ['admin', 'leads'] });
  };
}

// --------------------------------------------------------------- comercial

export function useMyAppointments(q: { leadId?: string; scope?: AppointmentScope }) {
  return useQuery({
    queryKey: [...ROOT, 'mine', q] as const,
    queryFn: () =>
      adminApiFetch<SalesAppointmentDto[]>(
        `/admin/sales/appointments${qs({ leadId: q.leadId, scope: q.scope })}`,
      ),
  });
}

export function useCreateMyAppointment(leadId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateSalesAppointmentInput) =>
      adminApiFetch<SalesAppointmentDto>(`/admin/sales/accounts/${leadId}/appointments`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: invalidate,
  });
}

export function useUpdateMyAppointment() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateSalesAppointmentInput }) =>
      adminApiFetch<SalesAppointmentDto>(`/admin/sales/appointments/${id}`, {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: invalidate,
  });
}

export function useDeleteMyAppointment() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) =>
      adminApiFetch<void>(`/admin/sales/appointments/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

// --------------------------------------------------------------- dirección

export function useTeamAppointments(
  q: { repId?: string; leadId?: string; scope?: AppointmentScope },
  enabled = true,
) {
  return useQuery({
    queryKey: [...ROOT, 'team', q] as const,
    queryFn: () =>
      adminApiFetch<SalesAppointmentDto[]>(
        `/admin/sales-team/appointments${qs({ repId: q.repId, leadId: q.leadId, scope: q.scope })}`,
      ),
    enabled,
  });
}

export function useCreateTeamAppointment() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: AdminCreateSalesAppointmentInput) =>
      adminApiFetch<SalesAppointmentDto>('/admin/sales-team/appointments', {
        method: 'POST',
        json: input,
      }),
    onSuccess: invalidate,
  });
}

export function useUpdateTeamAppointment() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateSalesAppointmentInput }) =>
      adminApiFetch<SalesAppointmentDto>(`/admin/sales-team/appointments/${id}`, {
        method: 'PATCH',
        json: input,
      }),
    onSuccess: invalidate,
  });
}

export function useDeleteTeamAppointment() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) =>
      adminApiFetch<void>(`/admin/sales-team/appointments/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}
