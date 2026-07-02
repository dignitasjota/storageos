type OriginCallback = (err: Error | null, allow?: boolean) => void;

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
        cache.set(host, { allow, exp: now + cacheTtlMs });
        cb(null, allow);
      })
      .catch(() => cb(null, false));
  };
}
