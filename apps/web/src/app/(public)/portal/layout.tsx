import { ThemeProvider } from 'next-themes';

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
    // `default` (no `black-translucent`): iOS reserva la barra de estado y no
    // dibuja el contenido debajo → evita que el portal (tema claro) quede bajo
    // el reloj. El home indicator inferior sí se compensa con safe-area en CSS.
    statusBarStyle: 'default',
    title: 'Mi trastero',
  },
  icons: {
    icon: [
      { url: '/favicon.png', type: 'image/png', sizes: '48x48' },
      { url: '/icon.svg', type: 'image/svg+xml' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
  },
};

export const viewport: Viewport = {
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0f172a' },
  ],
};

export default function PortalLayout({ children }: { children: ReactNode }) {
  return (
    // El portal del inquilino tiene su propio tema (clave separada, claro por
    // defecto), independiente del panel del tenant y del admin.
    <ThemeProvider
      attribute="class"
      defaultTheme="light"
      enableSystem
      disableTransitionOnChange
      storageKey="storageos-portal-theme"
    >
      <PwaRegister />
      {children}
    </ThemeProvider>
  );
}
