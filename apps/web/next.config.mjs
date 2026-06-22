import path from 'node:path';
import { fileURLToPath } from 'node:url';

import createNextIntlPlugin from 'next-intl/plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const withNextIntl = createNextIntlPlugin('./src/lib/i18n/request.ts');

/**
 * Content Security Policy.
 *
 * Desde Fase 13A.4 corre en modo **enforcement** (`Content-Security-Policy`)
 * tras pasar la auditoria en Report-Only sin violaciones inesperadas. El
 * endpoint `/api/csp-report` se mantiene activo: si el navegador bloquea
 * algun recurso real en produccion, los reportes seguiran llegando y nos
 * permitiran reaccionar (ver docs/ARCHITECTURE.md).
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
  transpilePackages: ['@storageos/ui'],
  // pnpm + Next dev (webpack): con `resolve.symlinks` por defecto (true),
  // webpack resuelve el symlink de los paquetes del workspace a su ruta
  // real (`packages/*`, FUERA de node_modules), por lo que el loader de
  // react-refresh —que excluye node_modules— sí les aplica el transform
  // de HMR e inyecta `import.meta.webpackHot.accept()` en el dist CJS de
  // `@storageos/shared` (`type: commonjs`), rompiendo el parse en `pnpm dev`
  // con "Cannot use 'import.meta' outside a module". Desactivar la
  // resolución de symlinks mantiene la ruta bajo node_modules → excluida del
  // HMR.
  //
  // ⚠️ SOLO en dev: en el build de producción `resolve.symlinks = false`
  // hace que el tracer del `output: 'standalone'` genere un symlink ROTO
  // para `apps/web/node_modules/next` (apunta a una ruta `.pnpm` que no se
  // copia con esa relativa), de modo que el server standalone crashea en
  // arranque con `Cannot find module 'next'` (502 en prod). CI no lo detecta
  // porque compila pero no arranca el server. Por eso lo gateamos a dev.
  webpack: (config, { dev }) => {
    if (dev) config.resolve.symlinks = false;
    return config;
  },
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
          // Fase 13A.4: enforcement activo (`Content-Security-Policy`).
          // El endpoint `/api/csp-report` sigue recibiendo violaciones
          // reales gracias a la directiva `report-uri`.
          { key: 'Content-Security-Policy', value: cspHeader },
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
