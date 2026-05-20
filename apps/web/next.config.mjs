import path from 'node:path';
import { fileURLToPath } from 'node:url';

import createNextIntlPlugin from 'next-intl/plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const withNextIntl = createNextIntlPlugin('./src/lib/i18n/request.ts');

/**
 * Content Security Policy.
 *
 * Modo `Report-Only` para no romper UX. Tras 1 semana en produccion sin
 * violaciones inesperadas reportadas en /api/csp-report, cambiar a
 * enforcement renombrando la cabecera a `Content-Security-Policy` (ver
 * directiva enforcement preparada abajo y docs/ARCHITECTURE.md).
 *
 * Excepcion: /widget/[slug] mantiene `frame-ancestors *` para permitir
 * el embebido en webs de terceros. Esa cabecera se aplica en
 * src/middleware.ts y nunca debe heredar este CSP estricto. Por eso el
 * matcher `source` de abajo excluye `/widget`.
 *
 * Directivas:
 * - default-src 'self': solo recursos propios por defecto.
 * - script-src 'self' + 'unsafe-inline': Next.js inyecta scripts inline
 *   (RSC payload, hydration) sin nonces por defecto. Migrar a nonces
 *   queda fuera de scope (requiere App Router + middleware con
 *   generacion dinamica). Stripe.js (js.stripe.com) queda preparado
 *   por si en el futuro se integra Stripe Elements en cliente.
 * - style-src 'self' + 'unsafe-inline': shadcn/ui + Radix inyectan
 *   `style=""` inline en componentes (popovers, tooltips, sidebar...).
 * - img-src 'self' data: blob: https:: data: cubre QR Verifactu
 *   embebido como data URL; blob: cubre previews locales de uploads;
 *   https: cubre signed URLs MinIO/S3 (host arbitrario configurado
 *   por env en cada despliegue).
 * - font-src 'self' data:: next/font (Geist) puede inlinear fonts
 *   como data URI.
 * - connect-src 'self' https:: 'self' cubre RSC y rutas internas;
 *   https: cubre el backend API (NEXT_PUBLIC_API_URL, otro origin) +
 *   PUT directos a signed URLs MinIO/S3 desde uploads.
 * - frame-src 'self' + Stripe: 'self' permite el preview del widget
 *   en /settings/widget (iframe same-origin). Stripe queda preparado.
 * - frame-ancestors 'none': bloquea que cualquiera nos embeba (anti
 *   clickjacking). El widget publico se sirve desde otra ruta y su
 *   CSP se inyecta en el middleware.
 * - form-action 'self': impide submits a dominios externos.
 * - object-src 'none': no flash, no plugins.
 * - base-uri 'self': impide <base href> a otros origenes.
 * - report-uri /api/csp-report: endpoint propio para recopilar
 *   violaciones en stdout (Loki/Grafana en prod).
 */
const isDev = process.env.NODE_ENV !== 'production';

const cspDirectives = {
  'default-src': ["'self'"],
  // 'unsafe-eval' SOLO en dev (Next/HMR + react-konva ocasionalmente).
  // En prod queda fuera.
  'script-src': [
    "'self'",
    "'unsafe-inline'",
    ...(isDev ? ["'unsafe-eval'"] : []),
    'https://js.stripe.com',
  ],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:', 'https:'],
  'font-src': ["'self'", 'data:'],
  // 'self' cubre RSC y rutas internas. https: cubre el backend API
  // (NEXT_PUBLIC_API_URL, otro origin) + PUT directos a signed URLs
  // MinIO/S3. En dev anadimos http: + ws: para HMR y backend local.
  'connect-src': ["'self'", 'https:', ...(isDev ? ['http:', 'ws:'] : [])],
  'frame-src': ["'self'", 'https://js.stripe.com', 'https://hooks.stripe.com'],
  'frame-ancestors': ["'none'"],
  'form-action': ["'self'"],
  'base-uri': ["'self'"],
  'object-src': ["'none'"],
  'report-uri': ['/api/csp-report'],
};

const cspHeader = Object.entries(cspDirectives)
  .map(([k, v]) => `${k} ${v.join(' ')}`)
  .join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Paquetes internos del monorepo que se publican como TS sin compilar.
  // `@storageos/shared` ya emite JS compilado a `dist/`, asi que no lo
  // anadimos aqui (transpilePackages le inyectaria HMR markers `import.meta`
  // sobre codigo CJS y rompe el parse).
  transpilePackages: ['@storageos/ui'],
  // Output `standalone` empaqueta el servidor Next con sus dependencias
  // minimas en `.next/standalone`, lo que permite imagenes Docker mucho
  // mas pequenas (solo copiamos esa carpeta + .next/static + public).
  // Ver apps/web/Dockerfile y docs/DEPLOYMENT.md.
  output: 'standalone',
  // En el build de Docker el root del monorepo esta dos niveles arriba
  // de apps/web; lo declaramos explicitamente para que el tracer de
  // archivos del standalone funcione correctamente con pnpm workspaces.
  outputFileTracingRoot: path.join(__dirname, '../../'),
  async headers() {
    return [
      {
        // El widget publico DEBE poder embeberse en cualquier origen.
        // La cabecera CSP definitiva la inyecta src/middleware.ts (con
        // `frame-ancestors *`), aqui solo dejamos X-Frame-Options
        // permisivo. NO aplicamos el CSP estricto a esta ruta.
        source: '/widget/:path*',
        headers: [{ key: 'X-Frame-Options', value: 'ALLOWALL' }],
      },
      {
        // Todo el resto del panel. Excluimos /widget y /api/csp-report
        // (este ultimo no necesita las cabeceras y evitamos posibles
        // bucles si el report-uri redirige).
        source: '/((?!widget|api/csp-report).*)',
        headers: [
          // En Fase 11A: modo Report-Only para auditar 1 semana en prod
          // sin romper nada. Para enforcement: renombrar a
          // 'Content-Security-Policy'.
          { key: 'Content-Security-Policy-Report-Only', value: cspHeader },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
