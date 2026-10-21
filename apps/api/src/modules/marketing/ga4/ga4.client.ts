import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { shiftDate, type Ga4PageRowInput, type Ga4SourceRowInput } from '@storageos/shared';

import {
  GoogleApiError,
  GoogleServiceAccount,
} from '../../../common/google/google-service-account';

import type { Env } from '../../../config/env.schema';

const API = 'https://analyticsdata.googleapis.com/v1beta';
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
 * `403403403` no da acceso y el resto devuelve datos generados.
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

  /** Sesiones por día, origen/medio/campaña y dispositivo. */
  async sourceRows(
    propertyId: string,
    startDate: string,
    endDate: string,
  ): Promise<Ga4SourceRowInput[]> {
    if (this.stub) return stubSources(startDate, endDate);
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
    if (this.stub) return stubPages(startDate, endDate);
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
    );
  }
  return out;
}
