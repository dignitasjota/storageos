import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  BusinessReminderCompletionDto,
  BusinessReminderDto,
  BusinessReminderSettingsDto,
  BusinessRemindersListDto,
  CompleteBusinessReminderInput,
  CreateBusinessReminderInput,
  ReminderForecastDto,
  ReminderReceiptUploadDto,
  RemindersDueCountDto,
  ReminderTemplateDto,
  TaskDto,
  UpdateBusinessReminderInput,
} from '@storageos/shared';

const key = ['business-reminders'] as const;

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['dashboard', 'today'] });
    void qc.invalidateQueries({ queryKey: ['calendar'] });
  };
}

export function useBusinessReminders(includeDone = false) {
  return useQuery({
    queryKey: [...key, 'list', includeDone],
    queryFn: () =>
      apiFetch<BusinessRemindersListDto>(
        `/business-reminders${includeDone ? '?includeDone=1' : ''}`,
      ),
  });
}

export function useReminderTemplates(enabled = true) {
  return useQuery({
    queryKey: [...key, 'templates'],
    queryFn: () => apiFetch<ReminderTemplateDto[]>('/business-reminders/templates'),
    enabled,
  });
}

export function useReminderCompletions(id: string | null) {
  return useQuery({
    queryKey: [...key, 'completions', id],
    queryFn: () =>
      apiFetch<BusinessReminderCompletionDto[]>(`/business-reminders/${id}/completions`),
    enabled: !!id,
  });
}

export function useReminderSettings() {
  return useQuery({
    queryKey: [...key, 'settings'],
    queryFn: () => apiFetch<BusinessReminderSettingsDto>('/business-reminders/settings'),
  });
}

export function useCreateReminder() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateBusinessReminderInput) =>
      apiFetch<BusinessReminderDto>('/business-reminders', { method: 'POST', json: input }),
    onSuccess: done,
  });
}

export function useUpdateReminder() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateBusinessReminderInput }) =>
      apiFetch<BusinessReminderDto>(`/business-reminders/${id}`, { method: 'PATCH', json: input }),
    onSuccess: done,
  });
}

export function useDeleteReminder() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/business-reminders/${id}`, { method: 'DELETE' }),
    onSuccess: done,
  });
}

export function useSnoozeReminder() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, days }: { id: string; days: number }) =>
      apiFetch<BusinessReminderDto>(`/business-reminders/${id}/snooze`, {
        method: 'POST',
        json: { days },
      }),
    onSuccess: done,
  });
}

export function useCompleteReminder() {
  const done = useInvalidate();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      input,
      file,
    }: {
      id: string;
      input: Omit<CompleteBusinessReminderInput, 'receiptKey' | 'receiptName' | 'receiptMime'>;
      file?: File | null;
    }) => {
      let receipt: Partial<CompleteBusinessReminderInput> = {};
      if (file) {
        const mime = file.type as 'application/pdf' | 'image/png' | 'image/jpeg';
        const up = await apiFetch<ReminderReceiptUploadDto>(
          `/business-reminders/${id}/receipt-upload-url`,
          { method: 'POST', json: { mimeType: mime } },
        );
        const res = await fetch(up.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': mime },
          body: file,
        });
        if (!res.ok) throw new Error('No se pudo subir el justificante');
        receipt = { receiptKey: up.key, receiptName: file.name.slice(0, 200), receiptMime: mime };
      }
      return apiFetch<BusinessReminderDto>(`/business-reminders/${id}/complete`, {
        method: 'POST',
        json: { ...input, ...receipt },
      });
    },
    onSuccess: () => {
      done();
      void qc.invalidateQueries({ queryKey: ['expenses'] });
    },
  });
}

export function useApplyReminderTemplate() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ key: tk, dueDate }: { key: string; dueDate?: string }) =>
      apiFetch<BusinessReminderDto[]>(`/business-reminders/templates/${tk}/apply`, {
        method: 'POST',
        json: dueDate ? { dueDate } : {},
      }),
    onSuccess: done,
  });
}

export function useUpdateReminderSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (weeklyDigest: boolean) =>
      apiFetch<BusinessReminderSettingsDto>('/business-reminders/settings', {
        method: 'PATCH',
        json: { weeklyDigest },
      }),
    onSuccess: (data) => qc.setQueryData([...key, 'settings'], data),
  });
}

export function useReminderCalendar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: 'create' | 'revoke') =>
      apiFetch<BusinessReminderSettingsDto>('/business-reminders/settings/calendar', {
        method: action === 'create' ? 'POST' : 'DELETE',
      }),
    onSuccess: (data) => qc.setQueryData([...key, 'settings'], data),
  });
}

export async function openReminderReceipt(id: string, completionId: string): Promise<void> {
  const { url } = await apiFetch<{ url: string }>(
    `/business-reminders/${id}/completions/${completionId}/receipt`,
  );
  window.open(url, '_blank', 'noopener');
}

/** Deshace el último «hecho» de un vencimiento. */
export function useUndoReminderCompletion() {
  const invalidate = useInvalidate();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<BusinessReminderDto & { expenseKept: boolean }>(`/business-reminders/${id}/undo`, {
        method: 'POST',
      }),
    onSuccess: () => {
      invalidate();
      void qc.invalidateQueries({ queryKey: ['expenses'] });
    },
  });
}

/** Crea una tarea con la fecha del vencimiento. */
export function useReminderTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<TaskDto>(`/business-reminders/${id}/task`, { method: 'POST', json: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tasks'] }),
  });
}

/** Lo que vence en los próximos meses y lo que suma. */
export function useReminderForecast(enabled: boolean, months = 12) {
  return useQuery({
    queryKey: [...key, 'forecast', months],
    queryFn: () => apiFetch<ReminderForecastDto>(`/business-reminders/forecast?months=${months}`),
    enabled,
  });
}

/** Vencidos o que vencen en 7 días (el número del menú). */
export function useRemindersDueCount(enabled: boolean) {
  return useQuery({
    queryKey: [...key, 'due-count'],
    queryFn: () => apiFetch<RemindersDueCountDto>('/business-reminders/due-count'),
    enabled,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
  });
}
