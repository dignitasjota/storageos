import { createHash, randomBytes } from 'node:crypto';
import { get as httpGet, type IncomingMessage } from 'node:http';

import { DahuaEventStreamParser, type DahuaStreamBlock } from './event-stream-parser';

/**
 * Abre la suscripción `attachFileProc` de un equipo Dahua con auth **Digest**
 * (handshake 401 → reintento) y mantiene el stream `multipart/x-mixed-replace`
 * abierto, emitiendo cada bloque (eventos + snapshot) al callback. Reconecta con
 * backoff si la conexión cae. Sin dependencias externas (http nativo).
 */
const md5 = (s: string): string => createHash('md5').update(s).digest('hex');

interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm?: string;
}

function parseChallenge(header: string): DigestChallenge | null {
  const m = /^Digest\s+(.*)$/i.exec(header.trim());
  if (!m) return null;
  const params: Record<string, string> = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,]*))/g;
  let x: RegExpExecArray | null;
  while ((x = re.exec(m[1] as string)) !== null) {
    params[(x[1] as string).toLowerCase()] = (x[2] ?? x[3] ?? '').trim();
  }
  if (!params.realm || !params.nonce) return null;
  return {
    realm: params.realm,
    nonce: params.nonce,
    ...(params.qop ? { qop: params.qop } : {}),
    ...(params.opaque ? { opaque: params.opaque } : {}),
    ...(params.algorithm ? { algorithm: params.algorithm } : {}),
  };
}

function buildAuth(method: string, uri: string, user: string, pass: string, c: DigestChallenge): string {
  const ha1 = md5(`${user}:${c.realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  const qop = c.qop?.split(',')[0]?.trim();
  const parts = [`username="${user}"`, `realm="${c.realm}"`, `nonce="${c.nonce}"`, `uri="${uri}"`];
  let response: string;
  if (qop) {
    const cnonce = randomBytes(8).toString('hex');
    const nc = '00000001';
    response = md5(`${ha1}:${c.nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  } else {
    response = md5(`${ha1}:${c.nonce}:${ha2}`);
  }
  parts.push(`response="${response}"`);
  if (c.opaque) parts.push(`opaque="${c.opaque}"`);
  if (c.algorithm) parts.push(`algorithm=${c.algorithm}`);
  return `Digest ${parts.join(', ')}`;
}

export interface StreamOptions {
  /** Base del equipo `http://<ip>` (sin barra final). */
  baseUrl: string;
  username: string;
  password: string;
  /** Códigos de evento a suscribir (p. ej. `['AccessControl']` o `['All']`). */
  events: string[];
  heartbeat?: number;
  onBlock: (block: DahuaStreamBlock) => void;
  onError?: (err: Error) => void;
}

/** Boundary del Content-Type de la respuesta (`multipart/...; boundary=xxx`). */
function boundaryFromResponse(res: IncomingMessage): string | undefined {
  const ct = res.headers['content-type'] ?? '';
  return /boundary=([^;]+)/i.exec(ct)?.[1]?.trim().replace(/^"|"$/g, '');
}

/** Abre una vez el stream (con handshake Digest). Resuelve cuando el stream acaba. */
export function openEventStream(opts: StreamOptions): { close: () => void } {
  const path = `/cgi-bin/snapManager.cgi?action=attachFileProc&Flags[0]=Event&Events=[${opts.events.join(
    ',',
  )}]&heartbeat=${opts.heartbeat ?? 5}`;
  const url = new URL(opts.baseUrl.replace(/\/+$/, '') + path);
  let aborted = false;
  let current: ReturnType<typeof httpGet> | null = null;

  const request = (authHeader?: string): void => {
    const headers: Record<string, string> = {};
    if (authHeader) headers.authorization = authHeader;
    current = httpGet(
      { hostname: url.hostname, port: url.port || 80, path: url.pathname + url.search, headers },
      (res) => {
        if (res.statusCode === 401 && !authHeader) {
          const challenge = parseChallenge(String(res.headers['www-authenticate'] ?? ''));
          res.resume();
          if (!challenge) {
            opts.onError?.(new Error('digest_challenge_invalido'));
            return;
          }
          request(buildAuth('GET', url.pathname + url.search, opts.username, opts.password, challenge));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          opts.onError?.(new Error(`http_${res.statusCode}`));
          return;
        }
        const parser = new DahuaEventStreamParser(boundaryFromResponse(res));
        res.on('data', (chunk: Buffer) => {
          try {
            for (const block of parser.push(chunk)) opts.onBlock(block);
          } catch (err) {
            opts.onError?.(err instanceof Error ? err : new Error(String(err)));
          }
        });
        res.on('end', () => {
          for (const block of parser.flush()) opts.onBlock(block);
        });
      },
    );
    current.on('error', (err) => {
      if (!aborted) opts.onError?.(err);
    });
  };

  request();
  return {
    close: () => {
      aborted = true;
      current?.destroy();
    },
  };
}
