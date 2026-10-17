import type { PublicWebLocale } from './i18n/messages';

/**
 * Idioma del documento en las páginas en inglés. El `<html lang>` lo pone el
 * layout raíz (español, sin leer la petición para no volver dinámicas todas
 * las páginas estáticas): aquí se corrige al empezar a pintar la página.
 */
export function HtmlLang({ locale }: { locale: PublicWebLocale }) {
  if (locale !== 'en') return null;
  return <script dangerouslySetInnerHTML={{ __html: "document.documentElement.lang='en-GB'" }} />;
}
