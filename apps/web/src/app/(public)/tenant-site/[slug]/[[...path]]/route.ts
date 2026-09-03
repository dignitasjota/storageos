import { promises as dns } from 'node:dns';
import * as https from 'node:https';
import { isIP } from 'node:net';

import { isDisallowedIp, isIpLiteralHostname, parseExternalSiteUrl } from '@storageos/shared';
import { NextResponse } from 'next/server';

import type { ExternalSiteDto } from '@storageos/shared';
import type { NextRequest } from 'next/server';
import type { IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';

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

type SafetyCheck = { ok: true; pinnedAddress: string; pinnedFamily: number } | { ok: false };

/**
 * Re-valida el hostname en el momento de CADA request (no solo al guardar la
 * URL): resuelve DNS una vez y comprueba que la IP resuelta sigue siendo
 * pública — defensa contra DNS rebinding (la URL pasó la validación al
 * guardarla, pero su DNS podría haber cambiado desde entonces a un rango
 * privado). Devuelve la IP validada para que la conexión real se "pinee" a
 * ella (ver `pinnedLookup` más abajo): si en vez de eso dejáramos que el
 * cliente HTTP volviera a resolver el hostname por su cuenta al conectar,
 * un atacante con DNS autoritativo del dominio (es SU dominio, lo configura
 * él) podría servir una respuesta distinta entre esta validación y la
 * conexión real (TTL muy bajo) — la IP que se valida aquí dejaría de ser la
 * IP a la que realmente nos conectamos.
 */
async function checkAndPin(baseUrl: string): Promise<SafetyCheck> {
  const check = parseExternalSiteUrl(baseUrl, platformHosts());
  if (!check.ok) return { ok: false };
  if (isIpLiteralHostname(check.hostname)) {
    // Ya es un literal de IP (validado por completo por parseExternalSiteUrl):
    // no hay DNS que resolver ni que pueda cambiar entre validación y conexión.
    const bare = check.hostname.replace(/^\[|\]$/g, '');
    const family = isIP(bare);
    if (family === 0) return { ok: false };
    return { ok: true, pinnedAddress: bare, pinnedFamily: family };
  }
  try {
    const { address, family } = await dns.lookup(check.hostname);
    if (isDisallowedIp(address)) return { ok: false };
    return { ok: true, pinnedAddress: address, pinnedFamily: family };
  } catch {
    return { ok: false };
  }
}

/** `lookup` de `https.request` que ignora la resolución DNS real y siempre
 *  devuelve la IP ya validada — así la conexión TCP se abre EXACTAMENTE
 *  contra la IP comprobada, nunca contra el resultado de una segunda
 *  resolución (que podría haber cambiado). El `Host`/SNI de la petición
 *  siguen siendo el hostname original (los fija `https.request` a partir de
 *  `options.hostname`, sin relación con lo que devuelva `lookup`), así que
 *  el certificado TLS del upstream se valida contra el dominio real.
 *
 *  GOTCHA verificado con un servidor HTTPS local real (Node 20): `net`/`tls`
 *  invoca `lookup` con `options.all: true` (resolución "Happy Eyeballs"), que
 *  espera un ARRAY `[{address, family}]` en el callback, no la forma simple
 *  de 3 argumentos — con esa forma simple, Node lanza en runtime
 *  `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined` en TODA petición
 *  (rompería la web externa de cualquier tenant que la use). Hay que
 *  responder con la forma que pida `options.all`. */
function pinnedLookup(address: string, family: number): LookupFunction {
  return (_hostname, options, callback) => {
    if (options && typeof options === 'object' && 'all' in options && options.all) {
      callback(null, [{ address, family }]);
    } else {
      callback(null, address, family);
    }
  };
}

interface ProxiedResponse {
  status: number;
  contentType: string | null;
  body: Buffer;
}

class ProxyError extends Error {
  constructor(public readonly kind: 'too_large' | 'timeout' | 'network') {
    super(kind);
  }
}

/** Reenvía un GET al upstream, conectando SIEMPRE a `pinnedAddress` (ver
 *  `checkAndPin`). Node core (`https.request`), no `fetch`: `fetch` no
 *  expone forma pública de fijar a qué IP conecta sin volver a resolver el
 *  hostname. No sigue redirects (un 3xx del upstream se devuelve tal cual,
 *  `https.request` nunca los sigue automáticamente). */
function fetchPinned(
  url: URL,
  pinnedAddress: string,
  pinnedFamily: number,
  accept: string,
): Promise<ProxiedResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { accept },
        lookup: pinnedLookup(pinnedAddress, pinnedFamily),
        timeout: UPSTREAM_TIMEOUT_MS,
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 502;
        const declaredLength = res.headers['content-length'];
        if (declaredLength && Number(declaredLength) > MAX_PROXY_BYTES) {
          res.destroy();
          reject(new ProxyError('too_large'));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_PROXY_BYTES) {
            res.destroy();
            reject(new ProxyError('too_large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const contentTypeHeader = res.headers['content-type'];
          resolve({
            status,
            contentType: Array.isArray(contentTypeHeader)
              ? (contentTypeHeader[0] ?? null)
              : (contentTypeHeader ?? null),
            body: Buffer.concat(chunks),
          });
        });
        res.on('error', () => reject(new ProxyError('network')));
      },
    );
    req.on('timeout', () => req.destroy(new ProxyError('timeout')));
    req.on('error', () => reject(new ProxyError('network')));
    req.end();
  });
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

  const safe = await checkAndPin(site.baseUrl);
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

  let upstream: ProxiedResponse;
  try {
    upstream = await fetchPinned(
      upstreamUrl,
      safe.pinnedAddress,
      safe.pinnedFamily,
      req.headers.get('accept') ?? '*/*',
    );
  } catch {
    return notAvailable(502);
  }

  if (upstream.status >= 300 && upstream.status < 400) return notAvailable(502);
  if (upstream.status < 200 || upstream.status >= 300) return notAvailable(404);

  // `Buffer` no es un `BodyInit` válido para TS (`.buffer` puede tipar como
  // `ArrayBuffer | SharedArrayBuffer`) — se copia a un `Uint8Array` plano.
  const bodyBytes = new Uint8Array(upstream.body);
  return new NextResponse(bodyBytes, {
    status: 200,
    headers: {
      'content-type': upstream.contentType ?? 'application/octet-stream',
      'cache-control': 'public, max-age=30',
      'x-content-type-options': 'nosniff',
    },
  });
}
