import { promises as dns } from 'node:dns';
import http from 'node:http';
import https from 'node:https';

import { Injectable } from '@nestjs/common';
import {
  SEO_CRAWLER_USER_AGENT,
  SEO_CRAWL_MAX_BYTES,
  SEO_CRAWL_MAX_REDIRECTS,
  SEO_CRAWL_REQUEST_TIMEOUT_MS,
  isDisallowedIp,
} from '@storageos/shared';

import { checkOutboundUrlShape } from '../../../common/security/safe-http-post';

import type { LookupAddress } from 'node:dns';

/**
 * GET seguro para el rastreador SEO (PR 10), contra SSRF:
 *
 *  1. Solo `http`/`https`, sin credenciales en la URL, sin IP privadas
 *     literales ni nombres internos (`checkOutboundUrlShape`, el de los
 *     webhooks salientes).
 *  2. Solo hosts de los dominios del proyecto (`allowHost`), comprobado en la
 *     petición inicial y en CADA redirección.
 *  3. La IP se valida en el momento de conectar (el `lookup` del propio
 *     socket): ninguna de las IP resueltas puede ser privada, de loopback,
 *     link-local o de metadatos. Así no hay ventana de DNS rebinding.
 *  4. Redirecciones seguidas a mano, con tope (5).
 *  5. Tamaño máximo de la respuesta (se corta la descarga) y tiempo máximo por
 *     petición (cuenta todo: conectar, esperar y leer).
 *
 * En las pruebas (`NODE_ENV=test`) se puede dirigir todo a un servidor local
 * simulado con `useTestRouting`: es lo único que permite 127.0.0.1, y fuera de
 * las pruebas lanza un error (no se puede abrir en producción).
 */

export type CrawlResolver = (hostname: string) => Promise<LookupAddress[]>;

const defaultResolver: CrawlResolver = (hostname) => dns.lookup(hostname, { all: true });

export interface CrawlFetchOptions {
  /** ¿Se puede pedir a este host? (minúsculas, sin punto final). */
  allowHost: (host: string) => boolean;
  accept?: string;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** ¿Se lee el cuerpo con este tipo de contenido? (por defecto, HTML, XML y texto). */
  readBody?: (contentType: string | null) => boolean;
  resolve?: CrawlResolver;
}

export interface CrawlFetchResult {
  /** La URL pedida. */
  url: string;
  /** Código de la primera respuesta (3xx si redirige); null si no hubo respuesta. */
  status: number | null;
  /** Código de la última respuesta (null si la última redirección no se siguió o falló). */
  finalStatus: number | null;
  /** Última dirección (a la que se llegó o a la que redirigía la última respuesta). */
  finalUrl: string;
  /** Direcciones tras la primera. */
  chain: string[];
  /** La última redirección va a un dominio que no es del proyecto (no se siguió). */
  externalRedirect: boolean;
  headers: Record<string, string>;
  contentType: string | null;
  body: string | null;
  ms: number;
  /** Código del problema (null si hubo respuesta). */
  error: string | null;
}

/** Errores del rastreo en palabras (para la pantalla). */
export const CRAWL_ERROR_TEXT: Record<string, string> = {
  timeout: 'tardó más de 15 segundos',
  too_large: 'la respuesta pasa de 3 MB',
  too_many_redirects: 'más de 5 redirecciones seguidas',
  host_not_allowed: 'es de un dominio que no es del proyecto',
  'unsafe:private_ip': 'apunta a una dirección interna (bloqueada por seguridad)',
  'unsafe:invalid_scheme': 'no es una dirección http o https',
  'unsafe:internal_hostname': 'apunta a un nombre interno (bloqueado por seguridad)',
  'unsafe:credentials_in_url': 'lleva usuario y contraseña en la dirección',
  'unsafe:invalid_url': 'no es una dirección válida',
  'unsafe:dns_empty': 'el dominio no resuelve',
  'unsafe:port_not_allowed': 'usa un puerto que no es el de las webs (80 o 443)',
  dns: 'el dominio no resuelve',
  network: 'falló la conexión',
};

export class UnsafeCrawlTarget extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'UnsafeCrawlTarget';
  }
}

interface TestRouting {
  port: number;
  resolve: CrawlResolver;
}

interface HopResult {
  status: number;
  location: string | null;
  headers: Record<string, string>;
  contentType: string | null;
  body: string | null;
}

const DEFAULT_READ = (ct: string | null) => !ct || /text\/|xml|xhtml|json/i.test(ct);

function charsetOf(ct: string | null): string {
  const m = /charset\s*=\s*"?([\w-]+)/i.exec(ct ?? '');
  return (m?.[1] ?? 'utf-8').toLowerCase();
}

function decode(buf: Buffer, ct: string | null): string {
  const cs = charsetOf(ct);
  try {
    return new TextDecoder(cs).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

@Injectable()
export class SeoCrawlFetcher {
  private testRouting: TestRouting | null = null;

  /**
   * Solo en pruebas: manda todas las peticiones a un servidor local (por http
   * y a ese puerto) y resuelve los nombres con `resolve`. Es lo único que deja
   * conectar a 127.0.0.1. Fuera de `NODE_ENV=test` lanza un error.
   */
  useTestRouting(routing: TestRouting | null): void {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('useTestRouting solo se puede usar en las pruebas');
    }
    this.testRouting = routing;
  }

  /** Pide una URL siguiendo las redirecciones permitidas. No lanza: el problema va en `error`. */
  async fetch(url: string, opts: CrawlFetchOptions): Promise<CrawlFetchResult> {
    const started = Date.now();
    const maxRedirects = opts.maxRedirects ?? SEO_CRAWL_MAX_REDIRECTS;
    const chain: string[] = [];
    let current = url;
    let first: number | null = null;
    const result = (over: Partial<CrawlFetchResult>): CrawlFetchResult => ({
      url,
      status: first,
      finalStatus: null,
      finalUrl: current,
      chain,
      externalRedirect: false,
      headers: {},
      contentType: null,
      body: null,
      ms: Date.now() - started,
      error: null,
      ...over,
    });
    for (let hop = 0; ; hop++) {
      const check = checkOutboundUrlShape(current);
      if (!check.ok) return result({ error: `unsafe:${check.reason}` });
      // Solo los puertos de las webs (80 y 443): una redirección a `:81` o `:9000`
      // llegaría a los paneles que el servidor publique (Nginx Proxy Manager,
      // Portainer, MinIO…). `URL` ya omite el puerto por defecto.
      if (check.url.port !== '' && process.env.NODE_ENV !== 'test') {
        return result({ error: 'unsafe:port_not_allowed' });
      }
      const host = check.url.hostname.toLowerCase().replace(/\.$/, '');
      if (!opts.allowHost(host)) {
        // La primera petición nunca llega aquí (el servicio solo pide hosts del
        // proyecto); en una redirección, se anota adónde iba sin seguirla.
        return hop === 0
          ? result({ error: 'host_not_allowed' })
          : result({ externalRedirect: true });
      }
      let res: HopResult;
      try {
        res = await this.request(check.url, opts);
      } catch (err) {
        const code =
          err instanceof UnsafeCrawlTarget
            ? `unsafe:${err.code}`
            : (err as Error).message === 'timeout'
              ? 'timeout'
              : (err as Error).message === 'too_large'
                ? 'too_large'
                : /ENOTFOUND|EAI_AGAIN/.test((err as NodeJS.ErrnoException).code ?? '')
                  ? 'dns'
                  : 'network';
        return result({ error: code });
      }
      if (first === null) first = res.status;
      if (res.status >= 300 && res.status < 400 && res.location) {
        let next: string;
        try {
          next = new URL(res.location, current).toString();
        } catch {
          return result({ finalStatus: res.status, error: 'unsafe:invalid_url' });
        }
        next = next.replace(/#.*$/, '');
        chain.push(next);
        current = next;
        if (hop + 1 > maxRedirects) return result({ error: 'too_many_redirects' });
        continue;
      }
      return result({
        finalStatus: res.status,
        headers: res.headers,
        contentType: res.contentType,
        body: res.body,
      });
    }
  }

  private request(url: URL, opts: CrawlFetchOptions): Promise<HopResult> {
    const routing = process.env.NODE_ENV === 'test' ? this.testRouting : null;
    // En las pruebas nunca se sale a la red: o el servidor simulado o nada.
    if (process.env.NODE_ENV === 'test' && !routing && !opts.resolve) {
      return Promise.reject(new Error('network_disabled_in_tests'));
    }
    const resolve = routing?.resolve ?? opts.resolve ?? defaultResolver;
    const timeoutMs = opts.timeoutMs ?? SEO_CRAWL_REQUEST_TIMEOUT_MS;
    const maxBytes = opts.maxBytes ?? SEO_CRAWL_MAX_BYTES;
    const readBody = opts.readBody ?? DEFAULT_READ;
    const client = routing ? http : url.protocol === 'https:' ? https : http;
    const lookup = (
      hostname: string,
      options: { all?: boolean },
      callback: (
        err: NodeJS.ErrnoException | null,
        address: string | LookupAddress[],
        family?: number,
      ) => void,
    ): void => {
      resolve(hostname)
        .then((addresses) => {
          if (addresses.length === 0) {
            callback(new UnsafeCrawlTarget('dns_empty'), '');
            return;
          }
          // En pruebas, el servidor simulado vive en 127.0.0.1: solo esa IP.
          const allowed = (ip: string) =>
            !isDisallowedIp(ip) || (routing !== null && ip === '127.0.0.1');
          if (addresses.some((a) => !allowed(a.address))) {
            callback(new UnsafeCrawlTarget('private_ip'), '');
            return;
          }
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0]!.address, addresses[0]!.family);
        })
        .catch((err: NodeJS.ErrnoException) => callback(err, ''));
    };

    return new Promise<HopResult>((resolveP, rejectP) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        fn();
      };
      const deadline = setTimeout(() => {
        finish(() => rejectP(new Error('timeout')));
        req.destroy(new Error('timeout'));
      }, timeoutMs);
      const req = client.request(
        {
          protocol: routing ? 'http:' : url.protocol,
          hostname: url.hostname,
          port: routing ? routing.port : url.port || undefined,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: {
            'user-agent': SEO_CRAWLER_USER_AGENT,
            accept: opts.accept ?? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
            'accept-language': 'es-ES,es;q=0.9',
          },
          lookup: lookup as unknown as http.RequestOptions['lookup'],
          timeout: timeoutMs,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
          }
          const contentType = headers['content-type'] ?? null;
          const location = headers['location'] ?? null;
          const isRedirect = status >= 300 && status < 400 && !!location;
          if (isRedirect || !readBody(contentType)) {
            // No hace falta el cuerpo: se corta ya.
            res.destroy();
            finish(() => resolveP({ status, location, headers, contentType, body: null }));
            return;
          }
          const declared = Number(headers['content-length'] ?? NaN);
          if (Number.isFinite(declared) && declared > maxBytes) {
            res.destroy();
            finish(() => rejectP(new Error('too_large')));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              res.destroy();
              finish(() => rejectP(new Error('too_large')));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () =>
            finish(() =>
              resolveP({
                status,
                location,
                headers,
                contentType,
                body: decode(Buffer.concat(chunks), contentType),
              }),
            ),
          );
          res.on('error', (err) => finish(() => rejectP(err)));
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (err) => finish(() => rejectP(err)));
      req.end();
    });
  }
}
