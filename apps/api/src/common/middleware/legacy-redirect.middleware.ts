import { Injectable, type NestMiddleware } from '@nestjs/common';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Captura cualquier request que NO empiece por `/v1/` (o sus excepciones)
 * y responde con un **308 Permanent Redirect** apuntando a la version
 * actual prefijada.
 *
 * Sirve como ventana de deprecacion mientras integraciones externas y
 * clientes antiguos migran al prefijo `/v1/`. Una vez todos los consumidores
 * apunten directamente a `/v1/...` podremos retirar este middleware.
 *
 * Excepciones (NO se redirigen):
 *   - `/v1/...` (ya esta en la version actual).
 *   - `/health` — usado por health checks de infra; cambiar la URL implicaria
 *     reconfigurar uptime monitors y readiness probes.
 *   - `/api/docs` y `/api/docs-json` — la UI Swagger se monta fuera del
 *     versioning porque sirve como documentacion global.
 *   - `/webhooks/...` — Stripe, Resend, GoCardless, etc. tienen las URLs
 *     registradas como endpoints fijos en cada proveedor externo. Cambiarlas
 *     requiere accion manual en cada dashboard.
 *   - `/public/widget/...` — embeds ya desplegados en sitios externos del
 *     cliente final; no podemos forzar un redirect que reescribiria URLs
 *     en `<iframe>` o `<script>` instalados fuera de nuestro control.
 *
 * Usamos **308** (no 301/302) porque preserva el metodo HTTP y el body
 * del request original. Esto es crítico para POST/PUT/PATCH/DELETE.
 */
@Injectable()
export class LegacyRedirectMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    legacyRedirectHandler(req, res, next);
  }
}

/**
 * Versión funcional del mismo middleware para `app.use(...)`. NestJS aplica
 * los middlewares registrados via `consumer.apply()` DESPUÉS del router
 * cuando `enableVersioning(URI)` está activo, así que el redirect debe
 * aplicarse via `app.use()` antes de `enableVersioning` para interceptar
 * rutas sin prefijo `/v1/` antes de que NestJS devuelva 404.
 */
export const legacyRedirectHandler: RequestHandler = (req, res, next) => {
  const url = req.url;

  if (
    url.startsWith('/v1/') ||
    url === '/v1' ||
    url === '/health' ||
    url.startsWith('/health?') ||
    url.startsWith('/health/') ||
    url.startsWith('/api/docs') ||
    url.startsWith('/webhooks/') ||
    url.startsWith('/public/widget/')
  ) {
    return next();
  }

  if (url === '/' || url === '/favicon.ico') {
    return next();
  }

  res.redirect(308, `/v1${url}`);
};
