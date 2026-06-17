/**
 * Endpoint para recibir violaciones del Content-Security-Policy.
 *
 * Configurado en `next.config.mjs` como `report-uri /api/csp-report`.
 * Los navegadores envían aquí un POST con el detalle de cada bloqueo.
 *
 * Emite una línea JSON estructurada (`evt: 'csp_violation'`) a stdout que
 * Promtail etiqueta como `evt="csp_violation"` en Loki, de modo que Grafana
 * puede graficar y alertar sobre picos (ver `observability/` y
 * docs/DEPLOYMENT.md §13). Aplicamos una deduplicación en memoria con TTL
 * para no inundar los logs cuando un mismo recurso bloqueado dispara cientos
 * de reports por sesión.
 *
 * Devolvemos 204 No Content para que el navegador no reintente.
 */
export const runtime = 'nodejs';

const DEDUP_TTL_MS = 60_000;
const seen = new Map<string, number>();

function shouldLog(key: string): boolean {
  const now = Date.now();
  // Limpieza oportunista para que el Map no crezca sin límite.
  if (seen.size > 500) {
    for (const [k, ts] of seen) {
      if (now - ts > DEDUP_TTL_MS) seen.delete(k);
    }
  }
  const last = seen.get(key);
  if (last && now - last < DEDUP_TTL_MS) return false;
  seen.set(key, now);
  return true;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const report: unknown = await req.json();
    // El cuerpo puede venir como `{ "csp-report": {...} }` (report-uri) o como
    // objeto del nuevo formato report-to. Normalizamos a los campos clave.
    const body = (report ?? {}) as Record<string, unknown>;
    const detail = (body['csp-report'] ?? body) as Record<string, unknown>;
    const directive =
      (detail['violated-directive'] as string) ?? (detail['effectiveDirective'] as string) ?? '';
    const blockedUri = (detail['blocked-uri'] as string) ?? (detail['blockedURL'] as string) ?? '';
    const documentUri =
      (detail['document-uri'] as string) ?? (detail['documentURL'] as string) ?? '';

    if (shouldLog(`${directive}|${blockedUri}`)) {
      console.warn(
        JSON.stringify({
          evt: 'csp_violation',
          directive,
          blockedUri,
          documentUri,
          ts: new Date().toISOString(),
        }),
      );
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        evt: 'csp_report_error',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  return new Response(null, { status: 204 });
}
