/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Transpila los paquetes internos del monorepo que se publican como TS
  // (no compilados). Si añadimos más paquetes, hay que listarlos aquí.
  transpilePackages: ['@storageos/ui', '@storageos/shared'],
};

export default nextConfig;
