import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { adminApiFetch } from './api';

import type {
  AdminBroadcastResultDto,
  AdminPlatformBannerDto,
  AdminSavedViewDto,
  AnnouncementPreviewDto,
  AnnouncementSegment,
  LifecycleEmailTemplateDto,
  NpsSurveyDetailDto,
  NpsSurveyDto,
  PlatformAnnouncementDto,
  PlatformEmailBodyDto,
  PlatformEmailProblemDto,
  PlatformEmailStatsDto,
  SavePlatformAnnouncementInput,
  UpdateLifecycleEmailInput,
  UpsertPlatformBannerInput,
  CreateNpsSurveyInput,
} from '@storageos/shared';

// ── Anuncios ────────────────────────────────────────────────────────────────

const announcementsKey = ['admin', 'announcements'] as const;

export function useAnnouncementsHistory() {
  return useQuery({
    queryKey: [...announcementsKey, 'history'],
    queryFn: () => adminApiFetch<PlatformAnnouncementDto[]>('/admin/announcements/history'),
    // Mientras alguno se envía o está programado, se refresca.
    refetchInterval: (q) =>
      q.state.data?.some((a) => a.status === 'sending' || a.status === 'scheduled')
        ? 15_000
        : false,
  });
}

export function useAnnouncementPreview(
  segment: AnnouncementSegment,
  commercial: boolean,
  enabled = true,
) {
  return useQuery({
    queryKey: [...announcementsKey, 'preview', segment, commercial],
    queryFn: () =>
      adminApiFetch<AnnouncementPreviewDto>('/admin/announcements/preview', {
        method: 'POST',
        json: { segment, commercial },
      }),
    enabled,
    placeholderData: (prev) => prev,
  });
}

export function useSaveAnnouncement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: SavePlatformAnnouncementInput }) =>
      adminApiFetch<PlatformAnnouncementDto>(
        id ? `/admin/announcements/${id}` : '/admin/announcements/drafts',
        { method: id ? 'PUT' : 'POST', json: input },
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: announcementsKey }),
  });
}

export function useAnnouncementAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      scheduledFor = null,
    }: {
      id: string;
      action: 'send' | 'cancel' | 'duplicate' | 'resend-missing' | 'delete';
      scheduledFor?: string | null;
    }) =>
      action === 'delete'
        ? adminApiFetch<null>(`/admin/announcements/${id}`, { method: 'DELETE' })
        : adminApiFetch<PlatformAnnouncementDto | AdminBroadcastResultDto | null>(
            `/admin/announcements/${id}/${action}`,
            { method: 'POST', json: action === 'send' ? { scheduledFor } : {} },
          ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: announcementsKey }),
  });
}

// Segmentos guardados (vistas guardadas de la página «announcements»).
export function useSavedSegments() {
  return useQuery({
    queryKey: ['admin', 'saved-views', 'announcements'],
    queryFn: () => adminApiFetch<AdminSavedViewDto[]>('/admin/saved-views?page=announcements'),
  });
}

export function useSaveSegment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, segment }: { name: string; segment: AnnouncementSegment }) =>
      adminApiFetch<AdminSavedViewDto>('/admin/saved-views', {
        method: 'POST',
        json: { page: 'announcements', name, filters: segment },
      }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['admin', 'saved-views', 'announcements'] }),
  });
}

export function useDeleteSegment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      adminApiFetch<void>(`/admin/saved-views/${id}`, { method: 'DELETE' }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['admin', 'saved-views', 'announcements'] }),
  });
}

// ── Banners ─────────────────────────────────────────────────────────────────

const bannersKey = ['admin', 'platform', 'banners'] as const;

export function useAdminBanners() {
  return useQuery({
    queryKey: bannersKey,
    queryFn: () => adminApiFetch<AdminPlatformBannerDto[]>('/admin/platform/banners'),
  });
}

export function useSaveBanner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: UpsertPlatformBannerInput }) =>
      adminApiFetch<AdminPlatformBannerDto>(
        id ? `/admin/platform/banners/${id}` : '/admin/platform/banners',
        { method: id ? 'PUT' : 'POST', json: input },
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: bannersKey }),
  });
}

export function useDeleteBanner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      adminApiFetch<void>(`/admin/platform/banners/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: bannersKey }),
  });
}

// ── Correos enviados ────────────────────────────────────────────────────────

export function useEmailStats(weeks = 8) {
  return useQuery({
    queryKey: ['admin', 'email-log', 'stats', weeks],
    queryFn: () => adminApiFetch<PlatformEmailStatsDto>(`/admin/email-log/stats?weeks=${weeks}`),
  });
}

export function useEmailProblems(enabled = true) {
  return useQuery({
    queryKey: ['admin', 'email-log', 'problems'],
    queryFn: () => adminApiFetch<PlatformEmailProblemDto[]>('/admin/email-log/problems'),
    enabled,
  });
}

export function useEmailBody(id: string | null) {
  return useQuery({
    queryKey: ['admin', 'email-log', 'body', id],
    queryFn: () => adminApiFetch<PlatformEmailBodyDto>(`/admin/email-log/${id}/body`),
    enabled: !!id,
  });
}

export function useResendEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      adminApiFetch<{ suppressed: string | null }>(`/admin/email-log/${id}/resend`, {
        method: 'POST',
        json: {},
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'email-log'] }),
  });
}

// ── Correos automáticos ─────────────────────────────────────────────────────

export function useLifecycleTemplates() {
  return useQuery({
    queryKey: ['admin', 'email-templates'],
    queryFn: () => adminApiFetch<LifecycleEmailTemplateDto[]>('/admin/email-templates'),
  });
}

export function useSaveLifecycleTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ code, input }: { code: string; input: UpdateLifecycleEmailInput | null }) =>
      adminApiFetch<LifecycleEmailTemplateDto[]>(`/admin/email-templates/${code}`, {
        method: input ? 'PUT' : 'DELETE',
        ...(input ? { json: input } : {}),
      }),
    onSuccess: (data) => qc.setQueryData(['admin', 'email-templates'], data),
  });
}

// ── Encuestas NPS ───────────────────────────────────────────────────────────

const npsKey = ['admin', 'nps'] as const;

export function useNpsSurveys() {
  return useQuery({
    queryKey: npsKey,
    queryFn: () => adminApiFetch<NpsSurveyDto[]>('/admin/nps-surveys'),
  });
}

export function useNpsSurvey(id: string | null) {
  return useQuery({
    queryKey: [...npsKey, id],
    queryFn: () => adminApiFetch<NpsSurveyDetailDto>(`/admin/nps-surveys/${id}`),
    enabled: !!id,
  });
}

export function useCreateNpsSurvey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateNpsSurveyInput) =>
      adminApiFetch<NpsSurveyDto>('/admin/nps-surveys', { method: 'POST', json: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: npsKey }),
  });
}

export function useNpsAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'send' | 'close' | 'delete' }) =>
      action === 'delete'
        ? adminApiFetch<null>(`/admin/nps-surveys/${id}`, { method: 'DELETE' })
        : adminApiFetch<NpsSurveyDto | null>(`/admin/nps-surveys/${id}/${action}`, {
            method: 'POST',
            json: {},
          }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: npsKey }),
  });
}
