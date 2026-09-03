/**
 * Guardas SSRF reutilizables para la «web externa» del tenant (proxy inverso
 * hacia una URL que el propio tenant controla, ver `packages/shared/src/web`).
 * Funciones PURAS (sin `dns`/`net` de Node) para poder importarse tanto en el
 * backend (Nest) como en el frontend (Next, incluido bundle de cliente) sin
 * romper el build del navegador. La resolución DNS (I/O, necesaria para
 * validar hostnames que NO son un literal de IP) vive en cada app que use
 * esto, llamando a `isDisallowedIp` sobre la IP resuelta.
 */

const IPV4_REGEX = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isValidOctet(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= 255;
}

/** ¿Es un literal de IPv4 (`a.b.c.d`) con octetos válidos? */
export function isIPv4Literal(value: string): boolean {
  const m = IPV4_REGEX.exec(value);
  if (!m) return false;
  return [m[1]!, m[2]!, m[3]!, m[4]!].every((o) => isValidOctet(Number(o)));
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function inRange(intIp: number, cidrBase: string, prefix: number): boolean {
  const base = ipv4ToInt(cidrBase);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (intIp & mask) === (base & mask);
}

/** Rangos IPv4 privados/loopback/link-local/reservados (RFC 1918, 5735, 6598…). */
const DISALLOWED_IPV4_RANGES: Array<[string, number]> = [
  ['0.0.0.0', 8], // "esta" red
  ['10.0.0.0', 8], // privada
  ['100.64.0.0', 10], // NAT de operador (carrier-grade NAT)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local
  ['172.16.0.0', 12], // privada
  ['192.0.0.0', 24], // asignaciones de protocolo IETF
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // privada
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reservado
  ['255.255.255.255', 32], // broadcast
];

function isDisallowedIpv4(ip: string): boolean {
  const int = ipv4ToInt(ip);
  return DISALLOWED_IPV4_RANGES.some(([base, prefix]) => inRange(int, base, prefix));
}

/**
 * Parsea un literal IPv6 a sus 8 hextets (0-65535 cada uno), aceptando
 * cualquier representación textual válida: comprimida (`::1`), expandida
 * (`0:0:0:0:0:0:0:1`), con ceros a la izquierda dentro de un hextet
 * (`0000:0000:...`), y con cola IPv4 embebida en forma decimal (`::ffff:
 * 127.0.0.1`) O en forma hexadecimal pura (`::ffff:7f00:1`, el mismo valor).
 * `null` si no es un literal IPv6 válido.
 *
 * Por qué hace falta esto y no vale una regex por prefijo: un mismo host
 * (p.ej. loopback) tiene MUCHAS representaciones textuales válidas y un
 * chequeo que solo reconoce una de ellas (`'::1'` exacto, o un prefijo de
 * string) deja pasar las demás — el hallazgo concreto que esto cierra.
 */
function parseIPv6(value: string): number[] | null {
  const v = value.toLowerCase();
  if (v === '') return null;
  const doubleColonCount = (v.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return null; // `::` como mucho una vez
  if (v.includes(':::')) return null;

  const [leftRaw, rightRaw] = doubleColonCount === 1 ? v.split('::') : [v, undefined];
  const leftParts = leftRaw ? leftRaw.split(':') : [];
  const rightParts = rightRaw ? rightRaw.split(':') : [];

  // Cola IPv4 embebida: el último grupo del lado derecho (o del único lado,
  // en forma completa sin `::`) puede ser un literal `a.b.c.d`.
  function expandIPv4Tail(parts: string[]): string[] | null {
    const last = parts.at(-1);
    if (last === undefined || !last.includes('.')) return parts;
    if (!isIPv4Literal(last)) return null;
    const int = ipv4ToInt(last);
    const high = (int >>> 16).toString(16);
    const low = (int & 0xffff).toString(16);
    return [...parts.slice(0, -1), high, low];
  }

  const left = expandIPv4Tail(leftParts);
  const right = expandIPv4Tail(rightParts);
  if (left === null || right === null) return null;

  const HEXTET_REGEX = /^[0-9a-f]{1,4}$/;
  if (![...left, ...right].every((g) => HEXTET_REGEX.test(g))) return null;

  const totalGroups = left.length + right.length;
  if (doubleColonCount === 0) {
    if (totalGroups !== 8) return null;
  } else {
    if (totalGroups >= 8) return null; // `::` debe rellenar >=1 grupo
  }
  const zerosToFill = 8 - totalGroups;
  const hextets = [
    ...left,
    ...Array<string>(doubleColonCount === 1 ? zerosToFill : 0).fill('0'),
    ...right,
  ];
  if (hextets.length !== 8) return null;
  return hextets.map((h) => parseInt(h, 16));
}

/**
 * ¿Es una IPv6 (o IPv4-mapeada/compatible en IPv6) en un rango loopback/
 * privado/link-local/no-especificado? Parseo numérico completo (no por
 * prefijo de string) para no depender de UNA representación textual
 * concreta — ver `parseIPv6`.
 */
function isDisallowedIpv6(ip: string): boolean {
  const hextets = parseIPv6(ip);
  if (!hextets) return false;
  const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  // IPv4 embebida: 5 primeros hextets a 0 y el 6º es 0 (compatible-deprecada
  // `::a.b.c.d`) o 0xffff (mapeada `::ffff:a.b.c.d`) → los dos últimos
  // hextets SON la IPv4 (en hex o en decimal-con-puntos, `parseIPv6` ya
  // normalizó ambas formas a los mismos hextets numéricos). Esto cubre
  // TAMBIÉN `::` (embebe 0.0.0.0) y `::1` (embebe 0.0.0.1) sin caso aparte:
  // ambas caen dentro de `0.0.0.0/8`, ya bloqueada por `isDisallowedIpv4`.
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && (h5 === 0 || h5 === 0xffff)) {
    const ipv4Int = ((h6 << 16) | h7) >>> 0;
    const ipv4 = [24, 16, 8, 0].map((shift) => (ipv4Int >>> shift) & 0xff).join('.');
    return isDisallowedIpv4(ipv4);
  }
  // Unique local fc00::/7 → los 7 bits altos de h0 son 1111110.
  if ((h0 & 0xfe00) === 0xfc00) return true;
  // Link-local fe80::/10 → los 10 bits altos de h0 son 1111111010.
  if ((h0 & 0xffc0) === 0xfe80) return true;
  return false;
}

/** ¿Es un literal de IPv6 (forma laxa: contiene `:`, sin `.` salvo mapeada)? */
function looksLikeIPv6Literal(value: string): boolean {
  return value.includes(':');
}

/** ¿La IP (v4 o v6) cae en un rango loopback/privado/link-local/reservado? */
export function isDisallowedIp(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, ''); // hostname de URL puede venir como `[::1]`
  if (isIPv4Literal(bare)) return isDisallowedIpv4(bare);
  if (looksLikeIPv6Literal(bare)) return isDisallowedIpv6(bare);
  return false;
}

/**
 * ¿El hostname (tal cual lo da `parseExternalSiteUrl`, con corchetes si es
 * IPv6) es YA un literal de IP? Si es así, `isDisallowedIp` ya lo validó por
 * completo — no hace falta (ni es correcto, `dns.lookup` con corchetes puede
 * fallar) resolverlo por DNS después. La resolución DNS solo aplica a
 * hostnames que son un DOMINIO.
 */
export function isIpLiteralHostname(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, '');
  return isIPv4Literal(bare) || looksLikeIPv6Literal(bare);
}

// `URL` (global WHATWG) no está tipado en este paquete (deliberadamente sin
// libs de DOM/Node — es universal, lo consumen tanto el backend como el
// bundle de cliente del frontend). Solo necesitamos esquema + host, así que
// se parsea con una regex acotada en vez de añadir una dependencia de tipos.
const SCHEME_HOST_REGEX =
  /^([a-zA-Z][a-zA-Z\d+.-]*):\/\/(?:[^/?#@]*@)?(\[[^\]]*\]|[^/?#:]+)(?::\d+)?(?:[/?#]|$)/;

function parseSchemeAndHost(url: string): { scheme: string; hostname: string } | null {
  const m = SCHEME_HOST_REGEX.exec(url.trim());
  if (!m) return null;
  return { scheme: m[1]!.toLowerCase(), hostname: m[2]! };
}

export type ExternalSiteUrlCheck =
  | { ok: true; hostname: string }
  | { ok: false; reason: 'invalid_url' | 'must_be_https' | 'private_ip' | 'platform_host' };

/**
 * Valida el FORMATO de una URL externa de tenant (sin I/O): esquema `https`,
 * hostname bien formado, rechaza IP-literal en rango prohibido, rechaza
 * `localhost`/`*.localhost` y los hosts de la propia plataforma (evita bucles
 * o exponer nuestros propios servicios). NO resuelve DNS — para hostnames que
 * son un dominio (no un literal de IP), la app que llame a esto debe además
 * resolver el hostname y volver a chequear con `isDisallowedIp` sobre la IP
 * resuelta (defensa contra DNS rebinding).
 */
export function parseExternalSiteUrl(
  url: string,
  platformHosts: readonly string[] = [],
): ExternalSiteUrlCheck {
  const parsed = parseSchemeAndHost(url);
  if (!parsed) return { ok: false, reason: 'invalid_url' };
  if (parsed.scheme !== 'https') return { ok: false, reason: 'must_be_https' };
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) return { ok: false, reason: 'invalid_url' };
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return { ok: false, reason: 'private_ip' };
  }
  if (platformHosts.some((h) => h.toLowerCase() === hostname)) {
    return { ok: false, reason: 'platform_host' };
  }
  if (isDisallowedIp(hostname)) {
    return { ok: false, reason: 'private_ip' };
  }
  return { ok: true, hostname };
}
