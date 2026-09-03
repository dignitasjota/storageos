type OriginCallback = (err: Error | null, allow?: boolean) => void;

/**
 * Tope de entradas del caché de hosts. El `Origin` de la request lo controla
 * el cliente por completo (cualquier hostname, no tiene que existir) → sin
 * límite, un atacante que mande muchas requests con un `Origin` distinto
 * cada vez (`https://a1.evil`, `https://a2.evil`, ...) hace crecer el `Map`
 * indefinidamente mientras viva el proceso — agotamiento de memoria lento.
 * 2000 cubre con margen holgado los dominios propios verificados reales de
 * cualquier tenant (hoy, unidades) sin dejar de acotar el peor caso.
 */
export const CORS_ORIGIN_MAX_CACHE_ENTRIES = 2000;

/**
 * Origin de CORS dinámico: permite los orígenes de `ALLOWED_ORIGINS` (panel,
 * landing de plataforma) y, además, cualquier dominio propio de tenant
 * VERIFICADO (white-label). El lookup a BD se cachea en memoria (TTL) para no
 * golpear la base en cada request; un dominio revocado deja de servirse en
 * ≤ TTL. Sin `origin` (curl, same-origin, server-to-server) se permite.
 */
export function createCorsOrigin(
  allowed: string[],
  isVerifiedDomain: (host: string) => Promise<boolean>,
  cacheTtlMs = 5 * 60_000,
): (origin: string | undefined, cb: OriginCallback) => void {
  const allowedSet = new Set(allowed);
  const cache = new Map<string, { allow: boolean; exp: number }>();

  function setCached(host: string, allow: boolean, now: number): void {
    // `Map` conserva el orden de inserción → borrar la primera clave
    // desaloja la más antigua (FIFO). Simple y suficiente: el objetivo es
    // acotar el tamaño, no una política de recencia exacta.
    cache.delete(host); // si ya existía, la re-inserción la manda al final
    if (cache.size >= CORS_ORIGIN_MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(host, { allow, exp: now + cacheTtlMs });
  }

  return (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedSet.has(origin)) return cb(null, true);

    let host: string;
    try {
      host = new URL(origin).hostname.toLowerCase();
    } catch {
      return cb(null, false);
    }

    const now = Date.now();
    const cached = cache.get(host);
    if (cached && cached.exp > now) return cb(null, cached.allow);

    isVerifiedDomain(host)
      .then((allow) => {
        setCached(host, allow, now);
        cb(null, allow);
      })
      .catch(() => cb(null, false));
  };
}
