import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { PwaRegister } from '@/components/pwa/pwa-register';

/**
 * Layout del portal del inquilino. Aquí se engancha la PWA (manifest +
 * apple-web-app + service worker) para que solo se ofrezca instalar en la
 * zona del inquilino, no en el panel de staff/admin.
 */
export const metadata: Metadata = {
  title: 'Mi trastero',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Mi trastero',
  },
  icons: {
    icon: '/icon.svg',
    apple: '/icon.svg',
  },
};

export const viewport: Viewport = {
  themeColor: '#0f172a',
};

export default function PortalLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PwaRegister />
      {children}
    </>
  );
}
