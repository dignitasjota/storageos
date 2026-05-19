import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/lib/i18n/request.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Paquetes internos del monorepo que se publican como TS sin compilar.
  // `@storageos/shared` ya emite JS compilado a `dist/`, asi que no lo
  // anadimos aqui (transpilePackages le inyectaria HMR markers `import.meta`
  // sobre codigo CJS y rompe el parse).
  transpilePackages: ['@storageos/ui'],
};

export default withNextIntl(nextConfig);
