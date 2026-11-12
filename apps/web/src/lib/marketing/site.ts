/** Dirección pública de la web de TrasterOS (para URLs absolutas). */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ??
  process.env.NEXT_PUBLIC_WEB_URL ??
  'https://trasteros.pro'
).replace(/\/$/, '');

export const ORGANIZATION_ID = `${SITE_URL}/#organization`;
