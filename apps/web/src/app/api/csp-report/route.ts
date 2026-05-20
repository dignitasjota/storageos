/**
 * Endpoint para recibir violaciones del Content-Security-Policy.
 *
 * Configurado en `next.config.mjs` como `report-uri /api/csp-report`.
 * Los navegadores envian aqui un POST con el detalle de cada bloqueo
 * (en modo Report-Only solo informativo, sin bloqueo real).
 *
 * Loguea a stdout via `console.warn` → en produccion lo recoge
 * Loki/Grafana (ver docs/DEPLOYMENT.md). Si en algun momento las
 * violaciones se vuelven ruidosas, se puede agregar deduplicacion en
 * memoria con TTL. Para el MVP no hace falta.
 *
 * Devolvemos 204 No Content para que el navegador no reintente.
 */
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  try {
    const report = await req.json();

    console.warn('[CSP violation]', JSON.stringify(report));
  } catch (err) {
    console.warn('[CSP report parse error]', err);
  }
  return new Response(null, { status: 204 });
}
