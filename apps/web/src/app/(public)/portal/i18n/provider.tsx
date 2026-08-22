'use client';

import { NextIntlClientProvider } from 'next-intl';
import { createContext, useContext, useEffect, useState } from 'react';

import esMessages from './es.json';
import {
  DEFAULT_PORTAL_LOCALE,
  PORTAL_LOCALE_STORAGE_KEY,
  getPortalMessages,
  intlLocaleForPortal,
  isPortalLocale,
  type PortalLocale,
} from './messages';

import type { AbstractIntlMessages } from 'next-intl';
import type { ReactNode } from 'react';

interface PortalLocaleContextValue {
  locale: PortalLocale;
  /** Cambia el idioma: actualiza el provider y lo recuerda en `localStorage`. */
  setLocale: (locale: PortalLocale) => void;
}

const PortalLocaleContext = createContext<PortalLocaleContextValue | null>(null);

export function usePortalLocale(): PortalLocaleContextValue {
  const ctx = useContext(PortalLocaleContext);
  if (!ctx) throw new Error('usePortalLocale debe usarse dentro de <PortalI18nProvider>');
  return ctx;
}

function readStoredLocale(): PortalLocale | null {
  try {
    const stored = localStorage.getItem(PORTAL_LOCALE_STORAGE_KEY);
    return stored && isPortalLocale(stored) ? stored : null;
  } catch {
    return null;
  }
}

function writeStoredLocale(locale: PortalLocale): void {
  try {
    localStorage.setItem(PORTAL_LOCALE_STORAGE_KEY, locale);
  } catch {
    /* localStorage no disponible */
  }
}

/**
 * Envuelve el portal en `NextIntlClientProvider`. El primer render (SSR +
 * hidratación) siempre usa español para no desincronizar servidor/cliente;
 * justo después de montar, si hay un idioma guardado (de una sesión previa o
 * elegido antes de iniciar sesión), se cambia — el mismo patrón que ya usa
 * el selector de tema claro/oscuro del portal.
 */
export function PortalI18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<PortalLocale>(DEFAULT_PORTAL_LOCALE);
  const [messages, setMessages] = useState<AbstractIntlMessages>(
    esMessages as unknown as AbstractIntlMessages,
  );

  useEffect(() => {
    const stored = readStoredLocale();
    if (stored && stored !== DEFAULT_PORTAL_LOCALE) {
      void getPortalMessages(stored).then((m) => {
        setMessages(m);
        setLocaleState(stored);
      });
    }
  }, []);

  function setLocale(next: PortalLocale): void {
    writeStoredLocale(next);
    if (next === locale) return;
    void getPortalMessages(next).then((m) => {
      setMessages(m);
      setLocaleState(next);
    });
  }

  return (
    <PortalLocaleContext.Provider value={{ locale, setLocale }}>
      <NextIntlClientProvider locale={intlLocaleForPortal(locale)} messages={messages}>
        {children}
      </NextIntlClientProvider>
    </PortalLocaleContext.Provider>
  );
}
