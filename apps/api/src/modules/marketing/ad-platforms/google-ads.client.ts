/**
 * Cliente HTTP de la API de Google Ads (gasto por campaña). Una instancia
 * por tenant, con SUS credenciales pegadas a mano (client id/secret del app
 * OAuth de Google Ads Developer Console + refresh token que el propio
 * tenant genera, p. ej. vía el OAuth Playground de Google — evita que
 * nosotros gestionemos un flujo OAuth propio ni pasemos la revisión de
 * Google). Sin SDK (fetch), mismo criterio que Redsys/Holded/GoCardless.
 *
 * Docs: https://developers.google.com/google-ads/api/rest/overview
 */
const API_VERSION = 'v18';
const ADS_BASE = 'https://googleads.googleapis.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface GoogleAdsCredentials {
  clientId: string;
  clientSecret: string;
  developerToken: string;
  refreshToken: string;
  /** Con o sin guiones; se normaliza. */
  customerId: string;
  loginCustomerId?: string | null;
}

export interface GoogleAdsSpendRow {
  /** YYYY-MM-DD */
  date: string;
  /** Euros (o la divisa de la cuenta), ya convertido de `cost_micros`. */
  cost: number;
}

const digitsOnly = (s: string) => s.replace(/[^0-9]/g, '');

export class GoogleAdsClient {
  constructor(private readonly creds: GoogleAdsCredentials) {}

  private async getAccessToken(): Promise<string> {
    let res: Response;
    try {
      res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: this.creds.clientId,
          client_secret: this.creds.clientSecret,
          refresh_token: this.creds.refreshToken,
        }),
      });
    } catch (err) {
      throw new Error(
        `Google Ads: error de red al renovar el token (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const desc =
        (json as { error_description?: string })?.error_description ?? `HTTP ${res.status}`;
      throw new Error(`Google Ads: token inválido (${desc})`);
    }
    const token = (json as { access_token?: string }).access_token;
    if (!token) throw new Error('Google Ads: respuesta de token sin access_token');
    return token;
  }

  private async search(query: string): Promise<Array<Record<string, unknown>>> {
    const accessToken = await this.getAccessToken();
    const customerId = digitsOnly(this.creds.customerId);
    let res: Response;
    try {
      res = await fetch(`${ADS_BASE}/${API_VERSION}/customers/${customerId}/googleAds:search`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'developer-token': this.creds.developerToken,
          'content-type': 'application/json',
          ...(this.creds.loginCustomerId
            ? { 'login-customer-id': digitsOnly(this.creds.loginCustomerId) }
            : {}),
        },
        body: JSON.stringify({ query }),
      });
    } catch (err) {
      throw new Error(
        `Google Ads: error de red (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errors = (json as { error?: { message?: string } })?.error?.message;
      throw new Error(`Google Ads: ${errors ?? `HTTP ${res.status}`}`);
    }
    return ((json as { results?: Array<Record<string, unknown>> }).results ?? []) as Array<
      Record<string, unknown>
    >;
  }

  /** Verifica las credenciales con una consulta mínima. Lanza si son inválidas. */
  async testConnection(): Promise<void> {
    await this.search('SELECT customer.id FROM customer LIMIT 1');
  }

  /** Gasto diario de una campaña en `[from, to]` (ambos inclusive, YYYY-MM-DD). */
  async getCampaignSpend(
    campaignId: string,
    from: string,
    to: string,
  ): Promise<GoogleAdsSpendRow[]> {
    const query = `SELECT segments.date, metrics.cost_micros FROM campaign WHERE campaign.id = ${Number(
      digitsOnly(campaignId),
    )} AND segments.date BETWEEN '${from}' AND '${to}'`;
    const rows = await this.search(query);
    return rows
      .map((r) => {
        const segments = r.segments as { date?: string } | undefined;
        const metrics = r.metrics as { costMicros?: string | number } | undefined;
        const date = segments?.date;
        const costMicros = Number(metrics?.costMicros ?? 0);
        if (!date) return null;
        return { date, cost: Math.round((costMicros / 1_000_000) * 100) / 100 };
      })
      .filter((r): r is GoogleAdsSpendRow => r !== null);
  }
}
