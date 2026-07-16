import { getRequestConfig } from 'next-intl/server';

import messages from '../../../messages/es.json';

import { formats } from './formats';

import type { AbstractIntlMessages } from 'next-intl';

/**
 * Configuracion de next-intl. Hoy solo soportamos `es-ES`; cuando anadamos
 * mas idiomas, este es el unico sitio que cambia (lee la cookie
 * `NEXT_LOCALE` o un header `Accept-Language`).
 */
export default getRequestConfig(async () => ({
  locale: 'es-ES',
  // next-intl acepta arrays en los mensajes en runtime (`t.raw`), pero su tipo
  // `AbstractIntlMessages` no los contempla; el cast lo concilia.
  messages: messages as unknown as AbstractIntlMessages,
  timeZone: 'Europe/Madrid',
  now: new Date(),
  formats,
}));
