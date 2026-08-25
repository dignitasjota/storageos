'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  BlogCoverUploadResponseDto,
  BlogPostDto,
  CreateBlogPostInput,
  UpdateBlogPostInput,
} from '@storageos/shared';

import { apiFetch } from '@/lib/auth/api';

const blogKey = ['blog-posts'] as const;
const blogDetailKey = (id: string) => ['blog-posts', id] as const;

export function useBlogPosts() {
  return useQuery({
    queryKey: blogKey,
    queryFn: () => apiFetch<BlogPostDto[]>('/blog-posts'),
  });
}

export function useBlogPost(id: string | null) {
  return useQuery({
    queryKey: blogDetailKey(id ?? ''),
    queryFn: () => apiFetch<BlogPostDto>(`/blog-posts/${id}`),
    enabled: id != null,
  });
}

export function useCreateBlogPost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBlogPostInput) =>
      apiFetch<BlogPostDto>('/blog-posts', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: blogKey }),
  });
}

export function useUpdateBlogPost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; input: UpdateBlogPostInput }) =>
      apiFetch<BlogPostDto>(`/blog-posts/${args.id}`, { method: 'PATCH', json: args.input }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: blogKey });
      void qc.invalidateQueries({ queryKey: blogDetailKey(data.id) });
    },
  });
}

export function useDeleteBlogPost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/blog-posts/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: blogKey }),
  });
}

export function useSetBlogPostCover() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; coverImageKey: string | null }) =>
      apiFetch<BlogPostDto>(`/blog-posts/${args.id}/cover`, {
        method: 'PUT',
        json: { coverImageKey: args.coverImageKey },
      }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: blogKey });
      void qc.invalidateQueries({ queryKey: blogDetailKey(data.id) });
    },
  });
}

/** Sube la portada de un post a MinIO vía URL firmada y confirma la key. */
export async function uploadBlogCover(id: string, file: File): Promise<BlogPostDto> {
  const presign = await apiFetch<BlogCoverUploadResponseDto>(`/blog-posts/${id}/cover/upload-url`, {
    method: 'POST',
    json: { mimeType: file.type, sizeBytes: file.size },
  });
  const put = await fetch(presign.uploadUrl, {
    method: 'PUT',
    headers: presign.requiredHeaders,
    body: file,
  });
  if (!put.ok) throw new Error('No se pudo subir la imagen');
  return apiFetch<BlogPostDto>(`/blog-posts/${id}/cover`, {
    method: 'PUT',
    json: { coverImageKey: presign.key },
  });
}
