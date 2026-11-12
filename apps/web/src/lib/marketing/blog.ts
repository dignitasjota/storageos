import type {
  PublicPlatformBlogPostDto,
  PublicPlatformBlogPostSummaryDto,
} from '@storageos/shared';

import { ApiUnavailableError, SERVER_API_URL, internalApiHeaders } from '@/lib/server-api';

/** Entradas publicadas del blog de TrasterOS (vacío si la API no responde). */
export async function fetchPlatformBlogPosts(): Promise<PublicPlatformBlogPostSummaryDto[]> {
  try {
    const res = await fetch(`${SERVER_API_URL}/v1/platform-blog`, {
      headers: internalApiHeaders(),
      next: { revalidate: 60 },
    });
    if (!res.ok) return [];
    return (await res.json()) as PublicPlatformBlogPostSummaryDto[];
  } catch {
    return [];
  }
}

/** Una entrada publicada, o null si no existe. Caída de la API → error (5xx, no 404). */
export async function fetchPlatformBlogPost(
  slug: string,
): Promise<PublicPlatformBlogPostDto | null> {
  let res: Response;
  try {
    res = await fetch(`${SERVER_API_URL}/v1/platform-blog/${encodeURIComponent(slug)}`, {
      headers: internalApiHeaders(),
      next: { revalidate: 60 },
    });
  } catch {
    throw new ApiUnavailableError(0);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new ApiUnavailableError(res.status);
  return (await res.json()) as PublicPlatformBlogPostDto;
}

export function formatBlogDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-ES', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Madrid',
  });
}
