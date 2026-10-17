/**
 * Llamadas al API desde el SERVIDOR del web (páginas públicas, metadatos,
 * middleware). Por la red interna si `INTERNAL_API_URL` está definida (no
 * sale a internet ni pasa por el proxy) y con `INTERNAL_API_TOKEN`, que el
 * API reconoce para no contarlas en los límites por IP: todas salen del mismo
 * servidor, así que sin esto las webs de todos los tenants compartían un único
 * límite y, con tráfico, la reserva y las webs empezaban a fallar.
 *
 * Sin las variables, se comporta como antes (URL pública, sin cabecera).
 * Solo para código de servidor: el navegador nunca ve el token.
 */
export const SERVER_API_URL =
  process.env.INTERNAL_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export function internalApiHeaders(): Record<string, string> {
  const token = process.env.INTERNAL_API_TOKEN;
  return token ? { 'x-internal-token': token } : {};
}

/** El API no respondió bien (caído, 5xx): la página debe dar error, no 404. */
export class ApiUnavailableError extends Error {
  constructor(readonly status: number) {
    super(`API no disponible (${status || 'sin respuesta'})`);
  }
}
