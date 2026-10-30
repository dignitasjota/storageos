import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

import { SERVER_API_URL, internalApiHeaders } from '@/lib/server-api';

const API_URL = SERVER_API_URL;

/**
 * Enlace corto de campaña de marketing (impreso en carteles/flyers, o en un
 * QR): cuenta el clic en el backend y redirige al booking del tenant con los
 * UTM ya puestos, para que la reserva atribuya la conversión a este canal.
 */
async function resolveTarget(code: string, tenantSlug: string | null): Promise<string | null> {
  try {
    // Desde un dominio propio, solo valen los enlaces de ese negocio.
    const qs = tenantSlug ? `?tenant=${encodeURIComponent(tenantSlug)}` : '';
    const res = await fetch(`${API_URL}/public/marketing/go/${encodeURIComponent(code)}${qs}`, {
      headers: internalApiHeaders(),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { targetUrl: string };
    return data.targetUrl;
  } catch {
    return null;
  }
}

export default async function ShortLinkPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const tenantSlug = (await headers()).get('x-storageos-tenant-slug');
  const target = await resolveTarget(code, tenantSlug);
  if (!target) notFound();
  redirect(target);
}
