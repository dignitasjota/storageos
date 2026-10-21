/**
 * Cliente HTTP de la Graph API de Meta (Facebook/Instagram Ads) — gasto por
 * campaña. Una instancia por tenant con SU token de acceso de larga
 * duración (generado a mano desde su Business Manager) y su cuenta
 * publicitaria. Sin SDK (fetch), mismo criterio que Redsys/Holded/GoCardless.
 *
 * Docs: https://developers.facebook.com/docs/marketing-api/insights
 */
import { round2, type AdDailyStats } from './ad-stats';

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';

/**
 * Acciones que cuentan como conversión: los tipos agregados de Meta (cada uno
 * ya incluye sus variantes de píxel y formularios, así que no se duplican).
 */
const CONVERSION_ACTIONS = new Set([
  'lead',
  'purchase',
  'contact',
  'schedule',
  'submit_application',
  'complete_registration',
]);

export interface MetaAdsCredentials {
  accessToken: string;
  /** Con o sin prefijo `act_`; se normaliza. */
  adAccountId: string;
}

const withActPrefix = (id: string) => (id.startsWith('act_') ? id : `act_${id}`);

export class MetaAdsClient {
  constructor(private readonly creds: MetaAdsCredentials) {}

  private async request<T>(path: string, params: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams({ ...params, access_token: this.creds.accessToken });
    let res: Response;
    try {
      res = await fetch(`${GRAPH_BASE}${path}?${qs.toString()}`);
    } catch (err) {
      throw new Error(
        `Meta Ads: error de red (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok || (json && typeof json === 'object' && 'error' in json)) {
      const message = (json as { error?: { message?: string } })?.error?.message;
      throw new Error(`Meta Ads: ${message ?? `HTTP ${res.status}`}`);
    }
    return json as T;
  }

  /** Verifica el token con una llamada ligera a la cuenta publicitaria. Lanza si es inválido. */
  async testConnection(): Promise<void> {
    await this.request(`/${withActPrefix(this.creds.adAccountId)}`, { fields: 'id' });
  }

  /** Gasto, impresiones, clics y conversiones por día de una campaña en `[from, to]` (inclusive). */
  async getCampaignStats(campaignId: string, from: string, to: string): Promise<AdDailyStats[]> {
    const timeRange = JSON.stringify({ since: from, until: to });
    const data = await this.request<{
      data?: Array<{
        date_start?: string;
        spend?: string;
        impressions?: string;
        clicks?: string;
        actions?: Array<{ action_type?: string; value?: string }>;
      }>;
    }>(`/${campaignId}/insights`, {
      fields: 'spend,impressions,clicks,actions',
      time_increment: '1',
      time_range: timeRange,
      level: 'campaign',
    });
    return (data.data ?? [])
      .map((r) =>
        r.date_start
          ? {
              date: r.date_start,
              cost: round2(Number(r.spend ?? 0)),
              impressions: Number(r.impressions ?? 0),
              clicks: Number(r.clicks ?? 0),
              conversions: (r.actions ?? [])
                .filter((a) => a.action_type && CONVERSION_ACTIONS.has(a.action_type))
                .reduce((n, a) => n + Number(a.value ?? 0), 0),
            }
          : null,
      )
      .filter((r): r is AdDailyStats => r !== null);
  }
}
