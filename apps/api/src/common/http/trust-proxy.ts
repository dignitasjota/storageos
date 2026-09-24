import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Configura Express `trust proxy` con el nº exacto de proxies inversos de
 * confianza, para que `req.ip`/`req.ips` reflejen la IP real del cliente
 * (la del `X-Forwarded-For` que añade el proxy) en vez de la del proxy.
 *
 * Lo consumen el throttler (`getTracker` usa `req.ips[0] ?? req.ip`), los
 * audit logs, `security_events` y las alertas de fuerza bruta. Compartido
 * por `main.ts` y el test factory para que el e2e ejercite lo mismo que prod.
 */
export function configureTrustProxy(app: NestExpressApplication, hops: number): void {
  // `0` desactiva: `req.ip` = dirección del socket (API sin proxy delante).
  app.set('trust proxy', hops > 0 ? hops : false);
}
