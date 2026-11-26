import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SEO_GA4_DIMENSIONS,
  SEO_GA4_METRICS,
  SEO_GA4_ORGANIC_FILTER,
  shiftDate,
  type Ga4PageRowInput,
  type Ga4SourceRowInput,
  type SeoGa4LandingRowInput,
} from '@storageos/shared';

import {
  GoogleApiError,
  GoogleServiceAccount,
} from '../../../common/google/google-service-account';

import type { Env } from '../../../config/env.schema';

const API = 'https://analyticsdata.googleapis.com/v1beta';
/** API de administración (flujos de datos de la propiedad). Hay que activarla en Google Cloud. */
const ADMIN_API = 'https://analyticsadmin.googleapis.com/v1beta';
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const PAGE_SIZE = 10_000;
const MAX_ROWS = 50_000;

interface RunReportResponse {
  rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[];
  rowCount?: number;
}

/** `20261021` → `2026-10-21`. */
const isoDate = (v: string) => `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
const int = (v: string | undefined) => Math.round(Number(v) || 0);

/**
 * Cliente de la Data API de Google Analytics 4 con la cuenta de servicio de la
 * plataforma (la misma de Search Console). El tenant la añade como «Lector»
 * en su propiedad.
 *
 * Con `NODE_ENV=test` o `GSC_MODE=stub` funciona simulado: la propiedad
 * `403403403` no da acceso (tampoco al descargar), la propiedad `N` mide la web con el ID `G-N` y el
 * resto devuelve datos generados.
 */
@Injectable()
export class Ga4Client {
  private readonly account: GoogleServiceAccount;

  constructor(config: ConfigService<Env, true>) {
    this.account = new GoogleServiceAccount(
      config.get('GSC_SERVICE_ACCOUNT_JSON', { infer: true }),
    );
  }

  get stub(): boolean {
    return process.env.GSC_MODE === 'stub' || process.env.NODE_ENV === 'test';
  }

  get available(): boolean {
    return this.stub || this.account.configured;
  }

  get serviceAccountEmail(): string | null {
    if (this.account.email) return this.account.email;
    return this.stub ? 'seo@trasteros-demo.iam.gserviceaccount.com' : null;
  }

  /** Comprueba el acceso a la propiedad; devuelve el motivo si no lo hay. */
  async checkAccess(propertyId: string): Promise<string | null> {
    if (this.stub) {
      return propertyId === '403403403' ? 'User does not have sufficient permissions' : null;
    }
    try {
      await this.runReport(propertyId, {
        dateRanges: [{ startDate: 'yesterday', endDate: 'today' }],
        metrics: [{ name: 'sessions' }],
        limit: 1,
      });
      return null;
    } catch (err) {
      if (err instanceof GoogleApiError && [400, 403, 404].includes(err.status)) return err.message;
      throw err;
    }
  }

  /**
   * ID de medición (`G-…`) de los flujos web de la propiedad. Sirve para
   * comprobar que la propiedad mide la web del negocio que la conecta.
   */
  async measurementIds(propertyId: string): Promise<string[]> {
    if (this.stub) return propertyId === '403403403' ? [] : [`G-${propertyId}`];
    const out: string[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const qs = new URLSearchParams({ pageSize: '200', ...(pageToken ? { pageToken } : {}) });
      const res = await this.account.request<{
        dataStreams?: { type?: string; webStreamData?: { measurementId?: string } }[];
        nextPageToken?: string;
      }>(
        SCOPE,
        'GET',
        `${ADMIN_API}/properties/${encodeURIComponent(propertyId)}/dataStreams?${qs.toString()}`,
      );
      for (const stream of res.dataStreams ?? []) {
        const id = stream.webStreamData?.measurementId;
        if (stream.type === 'WEB_DATA_STREAM' && id) out.push(id.toUpperCase());
      }
      if (!res.nextPageToken) break;
      pageToken = res.nextPageToken;
    }
    return out;
  }

  /** Sesiones por día, origen/medio/campaña y dispositivo. */
  async sourceRows(
    propertyId: string,
    startDate: string,
    endDate: string,
  ): Promise<Ga4SourceRowInput[]> {
    if (this.stub) {
      stubAccess(propertyId);
      return stubSources(startDate, endDate);
    }
    const rows = await this.paged(propertyId, {
      dateRanges: [{ startDate, endDate }],
      dimensions: [
        { name: 'date' },
        { name: 'sessionSource' },
        { name: 'sessionMedium' },
        { name: 'sessionCampaignName' },
        { name: 'deviceCategory' },
      ],
      metrics: [
        { name: 'sessions' },
        { name: 'engagedSessions' },
        { name: 'screenPageViews' },
        { name: 'keyEvents' },
      ],
    });
    return rows.map((r) => ({
      date: isoDate(r.dimensionValues[0]?.value ?? ''),
      source: (r.dimensionValues[1]?.value || '(direct)').slice(0, 200),
      medium: (r.dimensionValues[2]?.value || '(none)').slice(0, 200),
      campaign: (r.dimensionValues[3]?.value || '(not set)').slice(0, 200),
      device: (r.dimensionValues[4]?.value || 'unknown').slice(0, 40),
      sessions: int(r.metricValues[0]?.value),
      engagedSessions: int(r.metricValues[1]?.value),
      pageViews: int(r.metricValues[2]?.value),
      keyEvents: int(r.metricValues[3]?.value),
    }));
  }

  /** Páginas vistas por día y página. */
  async pageRows(
    propertyId: string,
    startDate: string,
    endDate: string,
  ): Promise<Ga4PageRowInput[]> {
    if (this.stub) {
      stubAccess(propertyId);
      return stubPages(startDate, endDate);
    }
    const rows = await this.paged(propertyId, {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'date' }, { name: 'pagePath' }],
      metrics: [{ name: 'screenPageViews' }, { name: 'sessions' }],
    });
    return rows.map((r) => ({
      date: isoDate(r.dimensionValues[0]?.value ?? ''),
      pagePath: (r.dimensionValues[1]?.value || '/').slice(0, 500),
      pageViews: int(r.metricValues[0]?.value),
      sessions: int(r.metricValues[1]?.value),
    }));
  }

  /**
   * SEO Avanzado (PR 12): solo el tráfico orgánico de Google
   * (`sessionDefaultChannelGroup = Organic Search` y fuente `google`) por día,
   * host y página de entrada, con sesiones, usuarios, sesiones con
   * interacción, duración media, páginas vistas y eventos clave.
   */
  async organicLandingRows(
    propertyId: string,
    startDate: string,
    endDate: string,
  ): Promise<SeoGa4LandingRowInput[]> {
    if (this.stub) {
      stubAccess(propertyId);
      return stubOrganicLanding(startDate, endDate);
    }
    const rows = await this.paged(propertyId, {
      dateRanges: [{ startDate, endDate }],
      dimensions: SEO_GA4_DIMENSIONS.map((name) => ({ name })),
      metrics: SEO_GA4_METRICS.map((name) => ({ name })),
      dimensionFilter: SEO_GA4_ORGANIC_FILTER,
    });
    const num = (v: string | undefined) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    return rows.map((r) => ({
      date: isoDate(r.dimensionValues[0]?.value ?? ''),
      host: (r.dimensionValues[1]?.value ?? '').slice(0, 255),
      landing: (r.dimensionValues[2]?.value ?? '').slice(0, 2000),
      sessions: int(r.metricValues[0]?.value),
      users: int(r.metricValues[1]?.value),
      engagedSessions: int(r.metricValues[2]?.value),
      averageSessionDuration: num(r.metricValues[3]?.value),
      pageViews: int(r.metricValues[4]?.value),
      keyEvents: num(r.metricValues[5]?.value),
    }));
  }

  private async paged(
    propertyId: string,
    body: Record<string, unknown>,
  ): Promise<NonNullable<RunReportResponse['rows']>> {
    const out: NonNullable<RunReportResponse['rows']> = [];
    for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
      const res = await this.runReport(propertyId, { ...body, limit: PAGE_SIZE, offset });
      const rows = res.rows ?? [];
      out.push(...rows);
      if (rows.length < PAGE_SIZE) break;
    }
    return out;
  }

  private runReport(propertyId: string, body: Record<string, unknown>): Promise<RunReportResponse> {
    return this.account.request<RunReportResponse>(
      SCOPE,
      'POST',
      `${API}/properties/${encodeURIComponent(propertyId)}:runReport`,
      body,
    );
  }
}

/** Datos simulados: Google orgánico e Instagram cada día. */
function stubSources(startDate: string, endDate: string): Ga4SourceRowInput[] {
  const out: Ga4SourceRowInput[] = [];
  for (let d = startDate, i = 0; d <= endDate && i < 400; d = shiftDate(d, 1), i++) {
    out.push(
      {
        date: d,
        source: 'google',
        medium: 'organic',
        campaign: '(organic)',
        device: 'mobile',
        sessions: 6,
        engagedSessions: 4,
        pageViews: 14,
        keyEvents: 1,
      },
      {
        date: d,
        source: 'instagram',
        medium: 'social',
        campaign: '(not set)',
        device: 'mobile',
        sessions: 3,
        engagedSessions: 1,
        pageViews: 5,
        keyEvents: 0,
      },
    );
  }
  return out;
}

function stubPages(startDate: string, endDate: string): Ga4PageRowInput[] {
  const out: Ga4PageRowInput[] = [];
  for (let d = startDate, i = 0; d <= endDate && i < 400; d = shiftDate(d, 1), i++) {
    out.push(
      { date: d, pagePath: '/', pageViews: 12, sessions: 8 },
      { date: d, pagePath: '/precios', pageViews: 7, sessions: 5 },
      // Dos firmas con su enlace secreto en la dirección (lo que mandaba la web).
      { date: d, pagePath: '/sign/tok-abc', pageViews: 1, sessions: 1 },
      { date: d, pagePath: '/sign/tok-def', pageViews: 1, sessions: 1 },
    );
  }
  return out;
}

/**
 * Tráfico orgánico simulado (determinista): la portada con buena interacción,
 * «/precios» con mucho tráfico y poca interacción (y una variante con
 * parámetros que se junta con ella) y una entrada sin página.
 */
function stubOrganicLanding(startDate: string, endDate: string): SeoGa4LandingRowInput[] {
  const out: SeoGa4LandingRowInput[] = [];
  const row = (
    date: string,
    landing: string,
    sessions: number,
    engaged: number,
    keyEvents: number,
  ): SeoGa4LandingRowInput => ({
    date,
    host: '',
    landing,
    sessions,
    users: Math.max(1, sessions - 1),
    engagedSessions: engaged,
    averageSessionDuration: engaged > sessions / 2 ? 95 : 20,
    pageViews: sessions * 2,
    keyEvents,
  });
  for (let d = startDate, i = 0; d <= endDate && i < 500; d = shiftDate(d, 1), i++) {
    out.push(
      row(d, '/', 20, 15, 1),
      row(d, '/precios', 12, 3, 0),
      row(d, '/precios?utm_source=newsletter', 2, 1, 0),
      row(d, '(not set)', 1, 0, 0),
    );
  }
  return out;
}

/** Simulado: la propiedad `403403403` no da acceso (como si nos quitaran el permiso). */
function stubAccess(propertyId: string): void {
  if (propertyId === '403403403') {
    throw new GoogleApiError('User does not have sufficient permissions for this property', 403);
  }
}
