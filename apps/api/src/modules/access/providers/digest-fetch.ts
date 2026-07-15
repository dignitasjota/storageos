import { createHash, randomBytes } from 'node:crypto';

/**
 * Cliente HTTP con autenticación **Digest** (RFC 2617) — la que usan los
 * terminales Dahua recientes en sus CGI (`accessControl.cgi`, `recordUpdater`…).
 * `fetch` de Node no la trae: hay que hacer el handshake de dos pasos
 *   1) petición sin auth → 401 con cabecera `WWW-Authenticate: Digest ...`
 *   2) reintento con `Authorization: Digest ...` calculado con el nonce.
 *
 * Sin dependencias externas (mismo criterio que el resto del proyecto).
 */

const md5 = (s: string): string => createHash('md5').update(s).digest('hex');

interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm?: string;
}

/** Parsea la cabecera `WWW-Authenticate: Digest realm="...", nonce="..", ...`. */
export function parseDigestChallenge(header: string): DigestChallenge | null {
  const m = /^Digest\s+(.*)$/i.exec(header.trim());
  if (!m) return null;
  const params: Record<string, string> = {};
  // key=value | key="value" separados por comas (los valores pueden llevar comas
  // dentro de comillas, poco habitual en el challenge; el split simple basta para
  // realm/nonce/qop/opaque/algorithm).
  const re = /(\w+)=(?:"([^"]*)"|([^,]*))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(m[1] as string)) !== null) {
    params[(match[1] as string).toLowerCase()] = (match[2] ?? match[3] ?? '').trim();
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

/**
 * Construye el valor de la cabecera `Authorization: Digest ...` para una
 * petición. `uri` es el path + query (no la URL absoluta). `cnonce`/`nc` se
 * pasan solo para poder testear con vectores deterministas; en producción el
 * `cnonce` es aleatorio.
 */
export function buildDigestAuthHeader(args: {
  method: string;
  uri: string;
  username: string;
  password: string;
  challenge: DigestChallenge;
  cnonce?: string;
  nc?: string;
}): string {
  const { method, uri, username, password, challenge } = args;
  const ha1 = md5(`${username}:${challenge.realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const qop = challenge.qop?.split(',')[0]?.trim();

  let response: string;
  const parts: string[] = [
    `username="${username}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
  ];
  if (qop) {
    const cnonce = args.cnonce ?? randomBytes(8).toString('hex');
    const nc = args.nc ?? '00000001';
    response = md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  } else {
    response = md5(`${ha1}:${challenge.nonce}:${ha2}`);
  }
  parts.push(`response="${response}"`);
  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);
  if (challenge.algorithm) parts.push(`algorithm=${challenge.algorithm}`);
  return `Digest ${parts.join(', ')}`;
}

export interface DigestFetchResult {
  ok: boolean;
  status: number;
  body: string;
}

/**
 * Hace una petición HTTP con Digest auth (handshake de 2 pasos). No lanza ante
 * fallos de red/timeout: devuelve `{ok:false, status:0}` para que el caller lo
 * registre sin romper (mismo contrato que los `LockProvider`).
 */
export async function digestRequest(args: {
  url: string;
  method?: string;
  username: string;
  password: string;
  timeoutMs?: number;
}): Promise<DigestFetchResult> {
  const method = args.method ?? 'GET';
  const timeoutMs = args.timeoutMs ?? 8_000;
  const parsed = new URL(args.url);
  const uri = `${parsed.pathname}${parsed.search}`;

  const doFetch = (headers: Record<string, string>): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(args.url, { method, headers, signal: controller.signal }).finally(() =>
      clearTimeout(timer),
    );
  };

  try {
    // Paso 1: sin auth → esperamos 401 con el challenge.
    const first = await doFetch({});
    if (first.status !== 401) {
      // Algún terminal antiguo acepta Basic o no exige auth: devolvemos lo que haya.
      return { ok: first.ok, status: first.status, body: await first.text() };
    }
    const wwwAuth = first.headers.get('www-authenticate');
    const challenge = wwwAuth ? parseDigestChallenge(wwwAuth) : null;
    if (!challenge) return { ok: false, status: 401, body: '' };

    // Paso 2: reintento con el header Digest calculado.
    const authHeader = buildDigestAuthHeader({
      method,
      uri,
      username: args.username,
      password: args.password,
      challenge,
    });
    const second = await doFetch({ authorization: authHeader });
    return { ok: second.ok, status: second.status, body: await second.text() };
  } catch {
    return { ok: false, status: 0, body: '' };
  }
}
