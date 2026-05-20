import path from 'node:path';
import { fileURLToPath } from 'node:url';

import createNextIntlPlugin from 'next-intl/plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const withNextIntl = createNextIntlPlugin('./src/lib/i18n/request.ts');

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
};

export default withNextIntl(nextConfig);
