import { getRequestConfig } from 'next-intl/server';

import messages from '../../../messages/es.json';

/**
 * Configuracion de next-intl. Hoy solo soportamos `es-ES`; cuando anadamos
 * mas idiomas, este es el unico sitio que cambia (lee la cookie
 * `NEXT_LOCALE` o un header `Accept-Language`).
 */
export default getRequestConfig(async () => ({
  locale: 'es-ES',
  messages,
  timeZone: 'Europe/Madrid',
  now: new Date(),
}));
