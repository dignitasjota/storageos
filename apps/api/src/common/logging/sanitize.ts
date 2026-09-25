/**
 * Saneado de datos de request antes de que lleguen a los logs (pino → Loki)
 * o a Sentry. Hay secretos que NO viajan en `Authorization`/cookies:
 *
 *  - cabeceras propias: `x-device-key` (cerraduras), `x-camera-token`
 *    (ingesta de cámaras), `x-inbound-secret` (email entrante);
 *  - query string: `GET /access/verify?key=<DEVICE_KEY>&pin=<PIN>` (terminales
 *    que integran por "URL con placeholders") y `hub.verify_token` de Meta;
 *  - tokens en la RUTA: firma de contrato, valoración NPS, invitación.
 *
 * Todo el que pueda leer los logs (Grafana/Loki, Sentry) podría abrir puertas,
 * firmar contratos ajenos o aceptar invitaciones. Funciones puras, sin deps.
 */

export const REDACTED = '[REDACTED]';

/** Cabeceras con secretos (en minúsculas, como las expone Node). */
export const SENSITIVE_HEADERS = [
  'authorization',
  'cookie',
  'x-device-key',
  'x-camera-token',
  'x-inbound-secret',
] as const;

/** Parámetros de query cuyo valor es un secreto (comparación exacta, sin mayúsculas). */
const SENSITIVE_QUERY_KEYS = new Set([
  'key',
  'pin',
  'qr',
  'card',
  'token',
  'secret',
  'code',
  'password',
  'hub.verify_token',
]);

/** Rutas cuyo último segmento es un token (con o sin prefijo `/v1`). */
const TOKEN_PATH_PATTERNS: RegExp[] = [
  /(\/public\/move-in\/sign\/)[^/?#]+/g,
  /(\/public\/reviews\/)(?!stats(?:[/?#]|$))[^/?#]+/g,
  /(\/invitations\/token\/)[^/?#]+/g,
];

function isSensitiveQueryKey(key: string): boolean {
  return SENSITIVE_QUERY_KEYS.has(key.toLowerCase());
}

/** Enmascara tokens de la ruta y valores sensibles de la query string. */
export function sanitizeUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const qIndex = url.indexOf('?');
  let path = qIndex === -1 ? url : url.slice(0, qIndex);
  const query = qIndex === -1 ? '' : url.slice(qIndex + 1);

  for (const re of TOKEN_PATH_PATTERNS) path = path.replace(re, `$1${REDACTED}`);
  if (!query) return path;

  const parts = query.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq === -1) return pair;
    let rawKey = pair.slice(0, eq);
    try {
      rawKey = decodeURIComponent(rawKey.replace(/\+/g, ' '));
    } catch {
      // clave mal codificada: se evalúa tal cual
    }
    return isSensitiveQueryKey(rawKey) ? `${pair.slice(0, eq)}=${REDACTED}` : pair;
  });
  return `${path}?${parts.join('&')}`;
}

/** Copia del objeto `query` ya parseado con los valores sensibles enmascarados. */
export function sanitizeQuery(query: unknown): unknown {
  if (!query || typeof query !== 'object') return query;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(query as Record<string, unknown>)) {
    out[k] = isSensitiveQueryKey(k) ? REDACTED : v;
  }
  return out;
}

/** Copia de un objeto de cabeceras con las sensibles enmascaradas. */
export function sanitizeHeaders(headers: unknown): unknown {
  if (!headers || typeof headers !== 'object') return headers;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    out[k] = (SENSITIVE_HEADERS as readonly string[]).includes(k.toLowerCase()) ? REDACTED : v;
  }
  return out;
}

/**
 * Serializer de `req` para pino-http: recibe el objeto ya serializado por
 * pino (`{ id, method, url, query, params, headers, remoteAddress, ... }`) y
 * devuelve una copia saneada. `params` se descarta: con el versioning URI
 * contiene la ruta troceada (`path: ['v1', 'public', 'reviews', '<token>']`)
 * y ya está en `url`.
 */
export function serializeRequestForLog(req: Record<string, unknown>): Record<string, unknown> {
  const { params: _params, ...rest } = req;
  return {
    ...rest,
    url: sanitizeUrl(req.url as string | undefined),
    query: sanitizeQuery(req.query),
    headers: sanitizeHeaders(req.headers),
  };
}
