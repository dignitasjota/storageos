import { promises as dns } from 'node:dns';
import http from 'node:http';
import https from 'node:https';

import { isDisallowedIp, isIpLiteralHostname } from '@storageos/shared';

import type { LookupAddress } from 'node:dns';

/**
 * Envío HTTP saliente a una URL que controla un TENANT (webhooks salientes),
 * blindado contra SSRF.
 *
 * El riesgo: el servidor de la plataforma hace la petición desde DENTRO de la
 * red Docker, así que una URL `http://loki:3100/...`, `http://172.18.0.5` o la
 * de los metadatos del VPS llegaría a infraestructura interna — y la respuesta
 * acaba en `webhook_deliveries.response_body`, visible para el tenant.
 *
 * Tres capas:
 *  1. `checkOutboundUrlShape` (al guardar Y al enviar): solo http/https, IPs
 *     literales públicas y hostnames con dominio (un nombre sin punto como
 *     `loki` o `api` lo resuelve el DNS interno de Docker).
 *  2. `createSafeLookup`: la resolución DNS se valida en el MOMENTO de
 *     conectar (es el `lookup` del propio socket). Validar antes y conectar
 *     después dejaría una ventana de DNS rebinding; así la IP comprobada es
 *     exactamente la IP a la que se conecta. Se rechaza si CUALQUIERA de las
 *     IPs resueltas es privada.
 *  3. Sin redirecciones: `http.request` no las sigue (con `fetch`, un 302 a
 *     `http://loki:3100` convertía el POST en GET y se leía la respuesta).
 */

export class UnsafeDestinationError extends Error {
  constructor(readonly reason: string) {
    super(`unsafe_destination:${reason}`);
    this.name = 'UnsafeDestinationError';
  }
}

export type OutboundUrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** Sufijos que nunca son un destino público (mDNS, resolución interna). */
const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

/** Validación sin red de una URL de destino saliente. */
export function checkOutboundUrlShape(raw: string): OutboundUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'invalid_scheme' };
  }
  if (url.username || url.password) return { ok: false, reason: 'credentials_in_url' };
  // WHATWG ya normaliza `0177.0.0.1` / `2130706433` a `127.0.0.1`.
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (isIpLiteralHostname(host)) {
    return isDisallowedIp(host) ? { ok: false, reason: 'private_ip' } : { ok: true, url };
  }
  if (!host.includes('.') || host === 'localhost') {
    return { ok: false, reason: 'internal_hostname' };
  }
  if (INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: 'internal_hostname' };
  }
  return { ok: true, url };
}

type Resolver = (hostname: string) => Promise<LookupAddress[]>;

const defaultResolver: Resolver = (hostname) => dns.lookup(hostname, { all: true });

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * `lookup` para `http.request`: resuelve y rechaza si alguna IP es privada.
 * Soporta las dos formas de callback (dirección única / `all: true`, que Node
 * usa con `autoSelectFamily`).
 */
export function createSafeLookup(resolve: Resolver = defaultResolver) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback): void => {
    resolve(hostname)
      .then((addresses) => {
        if (addresses.length === 0) {
          callback(new UnsafeDestinationError('dns_empty'), '');
          return;
        }
        if (addresses.some((a) => isDisallowedIp(a.address))) {
          callback(new UnsafeDestinationError('private_ip'), '');
          return;
        }
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      })
      .catch((err: NodeJS.ErrnoException) => callback(err, ''));
  };
}

export interface SafePostResult {
  status: number;
  text: string;
}

/**
 * POST con cuerpo ya serializado a una URL de tenant. Lanza
 * `UnsafeDestinationError` si el destino no es público, o un `Error` de red /
 * timeout. No sigue redirecciones (un 3xx se devuelve como status).
 */
export function safePostJson(args: {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  maxResponseBytes?: number;
  resolve?: Resolver;
}): Promise<SafePostResult> {
  const check = checkOutboundUrlShape(args.url);
  if (!check.ok) return Promise.reject(new UnsafeDestinationError(check.reason));
  const { url } = check;
  const maxBytes = args.maxResponseBytes ?? 16_384;
  const client = url.protocol === 'https:' ? https : http;

  return new Promise<SafePostResult>((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: 'POST',
        headers: { ...args.headers, 'content-length': Buffer.byteLength(args.body).toString() },
        lookup: createSafeLookup(args.resolve) as unknown as http.RequestOptions['lookup'],
        timeout: args.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          if (size >= maxBytes) return;
          chunks.push(chunk);
          size += chunk.length;
          if (size >= maxBytes) res.destroy();
        });
        const done = () =>
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8'),
          });
        res.on('end', done);
        res.on('close', done); // tras `destroy()` por tamaño no llega `end`
        res.on('error', done);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(args.body);
  });
}
