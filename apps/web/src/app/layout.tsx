import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';

import { Providers } from './providers';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { formats } from '@/lib/i18n/formats';

import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'StorageOS',
    template: '%s · StorageOS',
  },
  description:
    'Software todo-en-uno para self-storage: inquilinos, contratos, facturación Veri*Factu, cobros, control de accesos, CRM y analítica. En español y multi-local.',
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
