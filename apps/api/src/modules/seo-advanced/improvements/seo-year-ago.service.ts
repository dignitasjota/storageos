import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  SEO_YEAR_AGO_MISSING,
  seoPeriodCovered,
  seoShiftYears,
  seoTotalsFromSums,
  type SeoOpportunityYearAgoDto,
} from '@storageos/shared';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { syncedUntilOf } from '../seo-coverage';
import { SeoProjectsService, type SeoOwner } from '../seo-projects.service';

const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

interface SumsRow {
  c: number | null;
  i: number | null;
  w: number | null;
  ps: number | null;
  n: number | null;
}

/**
 * Una oportunidad frente al mismo periodo del año anterior (mejora 12): en un
 * negocio estacional como los trasteros, una bajada de septiembre se mira con
 * septiembre del año pasado, no solo con agosto. Avisa si no hay histórico.
 */
@Injectable()
export class SeoYearAgoService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly projects: SeoProjectsService,
  ) {}

  async forOpportunity(
    owner: SeoOwner | undefined,
    projectId: string,
    opportunityId: string,
  ): Promise<SeoOpportunityYearAgoDto> {
    await this.projects.resolveProject(owner, projectId);
    const opp = await this.admin.seoOpportunity.findFirst({
      where: { id: opportunityId, projectId },
      select: { query: true, domainId: true, metrics: true },
    });
    if (!opp) throw new NotFoundException({ code: 'seo_not_found', message: 'No existe.' });
    const gsc = (opp.metrics as { gsc?: { from?: string; to?: string } } | null)?.gsc;
    const from = gsc?.from;
    const to = gsc?.to;
    const none = (message: string): SeoOpportunityYearAgoDto => ({
      available: false,
      message,
      from: from ?? '',
      to: to ?? '',
      yearFrom: from ? seoShiftYears(from, -1) : '',
      yearTo: to ? seoShiftYears(to, -1) : '',
      current: null,
      yearAgo: null,
      impressionsPct: null,
      positionDiff: null,
    });
    if (!from || !to || !opp.domainId) {
      return none('Esta oportunidad no tiene datos de Search Console para comparar.');
    }
    const yearFrom = seoShiftYears(from, -1);
    const yearTo = seoShiftYears(to, -1);
    const sums = async (a: string, b: string) => {
      const [r] = await this.admin.$queryRaw<SumsRow[]>(Prisma.sql`
        SELECT SUM(clicks)::float8 AS c, SUM(impressions)::float8 AS i,
          SUM(position * impressions)::float8 AS w, SUM(position)::float8 AS ps, COUNT(*)::float8 AS n
        FROM seo_gsc_metrics
        WHERE domain_id = ${opp.domainId}::uuid AND grain = 'query' AND lower(query) = ${opp.query}
          AND date BETWEEN ${a}::date AND ${b}::date`);
      return seoTotalsFromSums({
        clicks: Number(r?.c ?? 0),
        impressions: Number(r?.i ?? 0),
        weightedPosition: Number(r?.w ?? 0),
        positionSum: Number(r?.ps ?? 0),
        rows: Number(r?.n ?? 0),
      });
    };
    const bounds = await this.admin.seoGscMetric.aggregate({
      where: { domainId: opp.domainId, grain: 'site' },
      _min: { date: true },
    });
    const siteDays = await this.admin.seoGscMetric.count({
      where: {
        domainId: opp.domainId,
        grain: 'site',
        date: { gte: new Date(`${yearFrom}T00:00:00Z`), lte: new Date(`${yearTo}T00:00:00Z`) },
      },
    });
    // Los días con detalle por búsqueda: si el año pasado solo hay totales (un Excel), no hay qué comparar.
    const detailRows = await this.admin.seoGscMetric.count({
      where: {
        domainId: opp.domainId,
        grain: 'query',
        date: { gte: new Date(`${yearFrom}T00:00:00Z`), lte: new Date(`${yearTo}T00:00:00Z`) },
      },
    });
    const covered =
      detailRows > 0 &&
      seoPeriodCovered({
        firstDate: dateOnly(bounds._min.date),
        from: yearFrom,
        to: yearTo,
        daysWithData: siteDays,
        syncedUntil: await syncedUntilOf(this.admin, [opp.domainId]),
      });
    const current = await sums(from, to);
    if (!covered) {
      return {
        ...none(SEO_YEAR_AGO_MISSING),
        current: {
          clicks: current.clicks,
          impressions: current.impressions,
          position: current.position,
        },
      };
    }
    const past = await sums(yearFrom, yearTo);
    return {
      available: true,
      message: null,
      from,
      to,
      yearFrom,
      yearTo,
      current: {
        clicks: current.clicks,
        impressions: current.impressions,
        position: current.position,
      },
      yearAgo: { clicks: past.clicks, impressions: past.impressions, position: past.position },
      impressionsPct:
        past.impressions > 0
          ? Math.round(((current.impressions - past.impressions) / past.impressions) * 1000) / 10
          : null,
      positionDiff:
        current.position !== null && past.position !== null
          ? Math.round((past.position - current.position) * 10) / 10
          : null,
    };
  }
}
