'use client';

import { useEffect } from 'react';

import { appName, tenantIconPath, tenantManifestPath } from '@/lib/portal/tenant-app';

/**
 * Dentro del portal (página de cliente, sin metadatos de servidor), cambia la
 * ficha de la app, el icono de iPhone y su nombre a los del operador de la
 * sesión: así, al instalar desde aquí, la app es la suya y no la de TrasterOS.
 */
export function TenantAppHead({
  slug,
  tenantName,
  iconVersion = '',
}: {
  slug: string;
  tenantName: string;
  /** Cambia al subir otro logo (ver `iconVersion` de tenant-app). */
  iconVersion?: string;
}) {
  useEffect(() => {
    const ensure = (selector: string, create: () => HTMLElement): HTMLElement => {
      const found = document.head.querySelector<HTMLElement>(selector);
      if (found) return found;
      const el = create();
      document.head.appendChild(el);
      return el;
    };
    const link = (rel: string) => () => {
      const l = document.createElement('link');
      l.rel = rel;
      return l;
    };
    ensure('link[rel="manifest"]', link('manifest')).setAttribute('href', tenantManifestPath(slug));
    ensure('link[rel="apple-touch-icon"]', link('apple-touch-icon')).setAttribute(
      'href',
      tenantIconPath(slug, 180, false, iconVersion),
    );
    ensure('meta[name="apple-mobile-web-app-title"]', () => {
      const m = document.createElement('meta');
      m.name = 'apple-mobile-web-app-title';
      return m;
    }).setAttribute('content', appName(tenantName));
  }, [slug, tenantName, iconVersion]);
  return null;
}
