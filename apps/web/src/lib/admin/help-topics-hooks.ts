import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { adminApiFetch } from './api';

import type {
  AdminHelpTopicDto,
  CreateHelpTopicInput,
  HelpImageUploadDto,
  UpdateHelpTopicInput,
} from '@storageos/shared';

const key = ['admin', 'help-topics'] as const;

/** Todas las guías de «Cómo funciona» (también las ocultas y sin publicar). */
export function useAdminHelpTopics() {
  return useQuery({
    queryKey: key,
    queryFn: () => adminApiFetch<AdminHelpTopicDto[]>('/admin/help-topics'),
  });
}

export function useCreateHelpTopic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateHelpTopicInput) =>
      adminApiFetch<AdminHelpTopicDto>('/admin/help-topics', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useUpdateHelpTopic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateHelpTopicInput }) =>
      adminApiFetch<AdminHelpTopicDto>(`/admin/help-topics/${encodeURIComponent(id)}`, {
        method: 'PUT',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}

/** Borra una guía creada o deja una del código como venía. */
export function useResetHelpTopic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      adminApiFetch<void>(`/admin/help-topics/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
}

/** Sube una imagen al bucket público y devuelve su clave (aún sin guardar en la guía). */
export function useUploadHelpImage() {
  return useMutation({
    mutationFn: async (file: File) => {
      const up = await adminApiFetch<HelpImageUploadDto>('/admin/help-topics/image-upload-url', {
        method: 'POST',
        json: { mimeType: file.type, sizeBytes: file.size },
      });
      const put = await fetch(up.uploadUrl, {
        method: 'PUT',
        headers: up.requiredHeaders,
        body: file,
      });
      if (!put.ok) throw new Error('No se pudo subir la imagen');
      return up.key;
    },
  });
}
