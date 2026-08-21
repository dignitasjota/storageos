import type { AbstractIntlMessages } from 'next-intl';

/**
 * i18n del portal del inquilino — AISLADO del `next-intl` global de la app
 * (fijo a `es-ES` para panel/admin) y del sistema de i18n de la web pública
 * del tenant (`/s/[slug]`, que resuelve el locale por segmento de URL). Aquí
 * NO hay ruta por idioma: el inquilino ya tiene sesión (o va a tenerla), así
 * que el locale se guarda como preferencia — en `localStorage` antes de
 * iniciar sesión (como el tema claro/oscuro), y en `customers.locale` una
 * vez autenticado (persiste entre dispositivos, editable en "Mis datos").
 */
export type PortalLocale = 'es' | 'en';
export const PORTAL_LOCALES: PortalLocale[] = ['es', 'en'];
export const DEFAULT_PORTAL_LOCALE: PortalLocale = 'es';

/** Clave de `localStorage` para el idioma antes de tener sesión (o de respaldo). */
export const PORTAL_LOCALE_STORAGE_KEY = 'storageos.portal.locale';

export function isPortalLocale(value: string): value is PortalLocale {
  return (PORTAL_LOCALES as string[]).includes(value);
}

/** Locale de `Intl`/`toLocaleString` para formatear fechas/precios según el idioma. */
export function intlLocaleForPortal(locale: PortalLocale): string {
  return locale === 'en' ? 'en-GB' : 'es-ES';
}

export async function getPortalMessages(locale: PortalLocale): Promise<AbstractIntlMessages> {
  const messages = locale === 'en' ? await import('./en.json') : await import('./es.json');
  return messages.default as unknown as AbstractIntlMessages;
}
