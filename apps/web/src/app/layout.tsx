import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';

import { Providers } from './providers';

import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { formats } from '@/lib/i18n/formats';

import './globals.css';

const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ??
  process.env.NEXT_PUBLIC_WEB_URL ??
  'https://trasteros.pro'
).replace(/\/$/, '');

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'TrasterOS — Software de gestión para self-storage y trasteros',
    template: '%s · TrasterOS',
  },
  description:
    'Software todo-en-uno para self-storage: inquilinos, contratos, facturación Veri*Factu, cobros por SEPA, tarjeta y Bizum, control de accesos, CRM y analítica. En español y multi-local.',
  applicationName: 'TrasterOS',
  authors: [{ name: 'TrasterOS' }],
  creator: 'TrasterOS',
  publisher: 'TrasterOS',
  formatDetection: { telephone: false, email: false, address: false },
  alternates: { canonical: '/' },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
  openGraph: {
    type: 'website',
    siteName: 'TrasterOS',
    locale: 'es_ES',
    url: SITE_URL,
    title: 'TrasterOS — Software de gestión para self-storage y trasteros',
    description:
      'Software todo-en-uno para self-storage: inventario, contratos, facturación Veri*Factu, cobros, control de accesos, CRM y analítica. En español y multi-local.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'TrasterOS — Software de gestión para self-storage',
    description:
      'La plataforma todo-en-uno para gestionar tu self-storage: contratos, facturación Veri*Factu, cobros, accesos, CRM y analítica.',
  },
  icons: {
    icon: [
      { url: '/favicon.png', type: 'image/png', sizes: '48x48' },
      { url: '/icon.svg', type: 'image/svg+xml' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
  },
};

// `viewport-fit=cover` es imprescindible para que iOS rellene las safe-areas
// (`env(safe-area-inset-*)`) en modo standalone (PWA con notch/home indicator).
// themeColor con variantes light/dark para la barra de estado del navegador.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0f172a' },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable}`}
    >
      <body className="min-h-screen bg-background font-sans antialiased">
        <NextIntlClientProvider locale={locale} messages={messages} formats={formats}>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
