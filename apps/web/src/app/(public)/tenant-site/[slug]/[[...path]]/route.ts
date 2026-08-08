import { promises as dns } from 'node:dns';

import { isDisallowedIp, isIpLiteralHostname, parseExternalSiteUrl } from '@storageos/shared';
import { NextResponse } from 'next/server';

import type { ExternalSiteDto } from '@storageos/shared';
import type { NextRequest } from 'next/server';

/**
 * Proxy inverso hacia la web EXTERNA de un tenant (ya alojada fuera de la
 * plataforma), servida bajo su dominio propio verificado — ver
 * `packages/shared/src/routing/custom-domain.ts` (`opts.externalSite`) y
 * `apps/web/src/middleware.ts`. El middleware reescribe TODA ruta no
 * reservada del dominio propio hacia aquí (`/tenant-site/<slug>/<path>`).
 *
 * Nunca almacenamos el contenido del tenant: cada request se reenvía en vivo.
 * Requiere runtime Node (usa `dns.lookup` para la defensa anti-SSRF).
 */
export const runtime = 'nodejs';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const MAX_PROXY_BYTES = 15 * 1024 * 1024; // 15MB por fichero — sobra para una web normal.
const UPSTREAM_TIMEOUT_MS = 8000;

function platformHosts(): string[] {
  const hosts = new Set<string>();
  for (const raw of [process.env.NEXT_PUBLIC_SITE_URL, process.env.NEXT_PUBLIC_API_URL]) {
    if (!raw) continue;
    try {
      hosts.add(new URL(raw).hostname.toLowerCase());
    } catch {
      // env inválida — se ignora.
    }
  }
  return [...hosts];
}

async function fetchExternalSite(slug: string): Promise<ExternalSiteDto | null> {
  try {
    const res = await fetch(`${API_URL}/public/landing/${encodeURIComponent(slug)}/external-site`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return (await res.json()) as ExternalSiteDto;
  } catch {
    return null;
  }
}

/**
 * Re-valida el hostname en el momento de CADA request (no solo al guardar la
 * URL): resuelve DNS y comprueba que la IP resuelta sigue siendo pública —
 * defensa contra DNS rebinding (la URL pasó la validación al guardarla, pero
 * su DNS podría haber cambiado desde entonces a un rango privado).
 */
async function isSafeToFetch(baseUrl: string): Promise<{ ok: true } | { ok: false }> {
  const check = parseExternalSiteUrl(baseUrl, platformHosts());
  if (!check.ok) return { ok: false };
  // Si el hostname YA es un literal de IP, `parseExternalSiteUrl` lo validó
  // por completo — no hace falta (ni es correcto, `dns.lookup` con corchetes
  // de IPv6 puede fallar) resolverlo por DNS.
  if (isIpLiteralHostname(check.hostname)) return { ok: true };
  try {
    const { address } = await dns.lookup(check.hostname);
    if (isDisallowedIp(address)) return { ok: false };
  } catch {
    return { ok: false };
  }
  return { ok: true };
}

function notAvailable(status: number): NextResponse {
  return new NextResponse('No disponible', { status });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; path?: string[] }> },
): Promise<NextResponse> {
  const { slug, path } = await params;

  const site = await fetchExternalSite(slug);
  if (!site) return notAvailable(404);

  const safe = await isSafeToFetch(site.baseUrl);
  if (!safe.ok) return notAvailable(502);

  const rel = path && path.length > 0 ? path.join('/') : '';
  const base = site.baseUrl.endsWith('/') ? site.baseUrl : `${site.baseUrl}/`;
  let upstreamUrl: URL;
  try {
    upstreamUrl = new URL(rel, base);
  } catch {
    return notAvailable(404);
  }
  upstreamUrl.search = req.nextUrl.search;

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'GET',
      redirect: 'manual', // no seguimos redirects del upstream a ciegas (v1).
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: { accept: req.headers.get('accept') ?? '*/*' },
    });
  } catch {
    return notAvailable(502);
  }

  if (upstream.status >= 300 && upstream.status < 400) return notAvailable(502);
  if (!upstream.ok) return notAvailable(404);

  const contentLength = upstream.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_PROXY_BYTES) return notAvailable(502);

  const buf = await upstream.arrayBuffer();
  if (buf.byteLength > MAX_PROXY_BYTES) return notAvailable(502);

  return new NextResponse(buf, {
    status: 200,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'cache-control': 'public, max-age=30',
      'x-content-type-options': 'nosniff',
    },
  });
}
