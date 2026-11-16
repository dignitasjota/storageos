import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

import {
  ApiUnavailableError,
  SERVER_API_URL,
  internalApiHeaders,
  serverApiTimeout,
} from '@/lib/server-api';

/** Quien abre el enlace: el API no cuenta robots ni el mismo visitante dos veces. */
interface Visitor {
  ip: string | null;
  userAgent: string | null;
  head: boolean;
}

/**
 * Enlace corto de campaña de marketing (impreso en carteles/flyers, o en un
 * QR): cuenta el clic en el backend y redirige a la web del negocio con el
 * origen ya puesto, para que la reserva atribuya la conversión a este canal.
 */
async function resolveTarget(
  code: string,
  tenantSlug: string | null,
  visitor: Visitor,
): Promise<string | null> {
  const qs = new URLSearchParams();
  // Desde un dominio propio, solo valen los enlaces de ese negocio.
  if (tenantSlug) qs.set('tenant', tenantSlug);
  if (visitor.head) qs.set('count', '0');
  const query = qs.toString();
  let res: Response;
  try {
    res = await fetch(
      `${SERVER_API_URL}/public/marketing/go/${encodeURIComponent(code)}${query ? `?${query}` : ''}`,
      {
        headers: {
          ...internalApiHeaders(),
          ...(visitor.ip ? { 'x-visitor-ip': visitor.ip } : {}),
          ...(visitor.userAgent ? { 'x-visitor-ua': visitor.userAgent } : {}),
        },
        cache: 'no-store',
        signal: serverApiTimeout(),
      },
    );
  } catch {
    throw new ApiUnavailableError(0);
  }
  if (res.status === 404) return null;
  // El API caído no es un enlace que no existe: página de error, no 404.
  if (!res.ok) throw new ApiUnavailableError(res.status);
  const data = (await res.json()) as { targetUrl: string };
  return data.targetUrl;
}

export default async function ShortLinkPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const h = await headers();
  // La IP del visitante la pone el proxy (`X-Real-IP`; en `X-Forwarded-For`, la última).
  const forwarded = h.get('x-forwarded-for')?.split(',').pop()?.trim() || null;
  const target = await resolveTarget(code, h.get('x-storageos-tenant-slug'), {
    ip: h.get('x-real-ip') || forwarded,
    userAgent: h.get('user-agent'),
    head: h.get('x-storageos-head') === '1',
  });
  if (!target) notFound();
  redirect(target);
}
