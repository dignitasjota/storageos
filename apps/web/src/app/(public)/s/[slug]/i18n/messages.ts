import type { AbstractIntlMessages } from 'next-intl';

/**
 * i18n de la web pública del tenant — AISLADO del `next-intl` global de la
 * app (`src/lib/i18n/request.ts`, fijo a `es-ES` para panel/portal). Aquí el
 * locale lo elige el VISITANTE anónimo vía la URL (`/s/[slug]` = español,
 * `/s/[slug]/l/[locale]` = otros idiomas — ver `[locale]/page.tsx`), no hay
 * sesión ni cookie de por medio.
 *
 * Alcance: solo se traduce el CHROME estático (botones, etiquetas,
 * cabeceras). El contenido que escribe el propio tenant (webHeadline,
 * webAbout, testimonios, preguntas/respuestas de FAQ, nombres/direcciones de
 * local) es texto libre en español y NO se traduce automáticamente — no hay
 * forma fiable de hacerlo sin una API de traducción de pago.
 */
export type PublicWebLocale = 'es' | 'en';
export const PUBLIC_WEB_LOCALES: PublicWebLocale[] = ['es', 'en'];
export const DEFAULT_PUBLIC_WEB_LOCALE: PublicWebLocale = 'es';

/** Segmento reservado para las rutas de idioma (`/s/[slug]/l/[locale]`). */
export const PUBLIC_WEB_LOCALE_SEGMENT = 'l';

export function isPublicWebLocale(value: string): value is PublicWebLocale {
  return (PUBLIC_WEB_LOCALES as string[]).includes(value);
}

/** Locale de `Intl`/`toLocaleString` para formatear precios según el idioma (la moneda sigue siendo EUR). */
export function intlLocaleFor(locale: PublicWebLocale): string {
  return locale === 'en' ? 'en-GB' : 'es-ES';
}

export async function getPublicWebMessages(locale: PublicWebLocale): Promise<AbstractIntlMessages> {
  const messages = locale === 'en' ? await import('./en.json') : await import('./es.json');
  return messages.default as unknown as AbstractIntlMessages;
}
