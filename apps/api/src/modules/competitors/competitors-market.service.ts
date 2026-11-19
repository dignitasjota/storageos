import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CompetitorUnitStatusEnum } from '@storageos/shared';

import { type FacilityScope } from '../../common/facility-scope';
import { AiService } from '../ai/ai.service';
import { COMPETITOR_PARSE_MARKER } from '../ai/stub-ai-provider';
import { resolveAnalyticsScope, unitWhere } from '../analytics/analytics-scope';
import { competitorComparablePrice } from '../analytics/pricing-engine';
import { PrismaService } from '../database/prisma.service';

import { competitorWhere } from './competitors.service';

import type {
  CompetitorAiParseResultDto,
  CompetitorTrendDto,
  CompetitorUnitExportRowDto,
  CompetitorUnitProposalDto,
  CompetitorUnitStatus,
  MarketPriceMapDto,
  MarketPricePointDto,
} from '@storageos/shared';

const round2 = (n: number) => Math.round(n * 100) / 100;
const FRESH_DAYS = 180;
const DAY = 86_400_000;

function median(list: number[]): number | null {
  if (list.length === 0) return null;
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Prompt para leer la página de tarifas de un competidor. */
const PARSE_SYSTEM = `${COMPETITOR_PARSE_MARKER} de un negocio de alquiler de trasteros de la competencia.
Te pegan el texto de su web (o de un anuncio) y extraes cada trastero que ofrecen.
Responde SOLO con un JSON así, sin texto alrededor:
{"units":[{"areaM2":número|null,"widthM":número|null,"depthM":número|null,"priceMonthly":número,"status":"available"|"occupied","externalRef":texto|null}],"notes":texto|null}
Reglas:
- priceMonthly es el precio al mes tal como lo publican (no quites ni añadas IVA).
- Si dan medidas (p. ej. «2 x 3 m») pon widthM y depthM; si dan m², areaM2.
- status «occupied» solo si dicen que está agotado, completo o no disponible.
- En notes resume en una frase lo que no son trasteros (promociones, fianza, alta, seguro).
- No inventes trasteros: si no hay ninguno claro, devuelve "units": [].`;

/**
 * Lo que se calcula con la competencia fichada: tu precio frente al mercado,
 * la evolución de cada competidor, la exportación y la lectura de su web con IA.
 */
@Injectable()
export class CompetitorsMarketService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
  ) {}

  /** Tu precio medio frente al del mercado (comparable, sin IVA) por tipo de trastero. */
  async priceMap(
    tenantId: string,
    facilityScope?: FacilityScope,
    facilityId?: string | null,
  ): Promise<MarketPriceMapDto> {
    const scope = resolveAnalyticsScope(facilityScope ?? null, facilityId ?? undefined);
    const freshCut = Date.now() - FRESH_DAYS * DAY;
    const { myUnits, competitors } = await this.prisma.withTenant(
      async (tx) => ({
        myUnits: await tx.unit.findMany({
          where: { ...unitWhere(scope), status: { in: ['available', 'reserved', 'occupied'] } },
          select: {
            areaM2: true,
            basePriceMonthly: true,
            unitTypeId: true,
            unitType: { select: { name: true } },
          },
        }),
        competitors: await tx.competitorFacility.findMany({
          where: competitorWhere(facilityScope, facilityId),
          select: {
            name: true,
            priceIncludesVat: true,
            mandatoryInsuranceMonthly: true,
            setupFee: true,
            promoFreeMonths: true,
            promoDiscountPct: true,
            promoDiscountMonths: true,
            promoEndsAt: true,
            units: { select: { areaM2: true, priceMonthly: true, lastCheckedAt: true } },
          },
        }),
      }),
      tenantId,
    );

    const market: MarketPricePointDto[] = [];
    for (const c of competitors) {
      for (const u of c.units) {
        // Solo lo comprobado en los últimos 180 días (como en la sugerencia de precio).
        if (u.lastCheckedAt.getTime() < freshCut) continue;
        const area = Number(u.areaM2);
        if (area <= 0) continue;
        market.push({
          source: 'competitor',
          name: c.name,
          areaM2: round2(area),
          price: round2(competitorComparablePrice(c, Number(u.priceMonthly))),
        });
      }
    }

    const types = new Map<string, { name: string; areas: number[]; prices: number[] }>();
    const mine: MarketPricePointDto[] = [];
    for (const u of myUnits) {
      const area = Number(u.areaM2 ?? 0);
      const price = Number(u.basePriceMonthly);
      const t = types.get(u.unitTypeId) ?? { name: u.unitType.name, areas: [], prices: [] };
      if (area > 0) t.areas.push(area);
      t.prices.push(price);
      types.set(u.unitTypeId, t);
      if (area > 0)
        mine.push({ source: 'mine', name: u.unitType.name, areaM2: round2(area), price });
    }

    const rows = [...types.entries()]
      .map(([unitTypeId, t]) => {
        const area = t.areas.length ? t.areas.reduce((a, b) => a + b, 0) / t.areas.length : 0;
        const myPrice = t.prices.reduce((a, b) => a + b, 0) / t.prices.length;
        const near = market
          .filter((p) => area > 0 && p.areaM2 >= area * 0.75 && p.areaM2 <= area * 1.25)
          .map((p) => p.price);
        const med = median(near);
        return {
          unitTypeId,
          name: t.name,
          areaM2: round2(area),
          myPrice: round2(myPrice),
          marketMedian: med === null ? null : round2(med),
          marketMin: near.length ? round2(Math.min(...near)) : null,
          marketMax: near.length ? round2(Math.max(...near)) : null,
          samples: near.length,
          gapPct: med ? Math.round((myPrice / med - 1) * 1000) / 10 : null,
        };
      })
      .sort((a, b) => a.areaM2 - b.areaM2);

    return {
      facilityId: scope.explicit ? (facilityId ?? null) : null,
      rows,
      points: [...mine, ...market],
    };
  }

  /** Precio comparable medio y ocupación de un competidor al cerrar cada mes. */
  async trend(
    tenantId: string,
    competitorFacilityId: string,
    facilityScope?: FacilityScope,
    months = 12,
  ): Promise<CompetitorTrendDto> {
    const competitor = await this.prisma.withTenant(
      (tx) =>
        tx.competitorFacility.findFirst({
          where: { id: competitorFacilityId, ...competitorWhere(facilityScope) },
          select: {
            priceIncludesVat: true,
            mandatoryInsuranceMonthly: true,
            setupFee: true,
            promoFreeMonths: true,
            promoDiscountPct: true,
            promoDiscountMonths: true,
            promoEndsAt: true,
            inventoryComplete: true,
            units: {
              select: {
                observations: {
                  orderBy: { observedAt: 'asc' },
                  select: { observedAt: true, priceMonthly: true, status: true },
                },
              },
            },
          },
        }),
      tenantId,
    );
    if (!competitor) {
      throw new NotFoundException({
        code: 'competitor_facility_not_found',
        message: 'Local de la competencia no encontrado',
      });
    }
    const now = new Date();
    const points: CompetitorTrendDto['points'] = [];
    for (let i = months - 1; i >= 0; i--) {
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 1));
      const ym = new Date(end.getTime() - DAY).toISOString().slice(0, 7);
      const prices: number[] = [];
      let seen = 0;
      let occupied = 0;
      for (const u of competitor.units) {
        // Lo último que se sabía de cada trastero al acabar el mes.
        let last: { priceMonthly: { toString(): string }; status: string } | null = null;
        for (const o of u.observations) {
          if (o.observedAt >= end) break;
          last = o;
        }
        if (!last) continue;
        seen += 1;
        if (last.status === 'occupied') occupied += 1;
        prices.push(
          competitorComparablePrice(competitor, Number(last.priceMonthly.toString()), end),
        );
      }
      points.push({
        yearMonth: ym,
        avgComparablePrice: prices.length
          ? round2(prices.reduce((a, b) => a + b, 0) / prices.length)
          : null,
        occupancy: competitor.inventoryComplete && seen > 0 ? round2(occupied / seen) : null,
      });
    }
    return { points };
  }

  /** Todos los trasteros de la competencia que ve el usuario, para exportar. */
  async exportUnits(
    tenantId: string,
    facilityScope?: FacilityScope,
    facilityId?: string | null,
  ): Promise<CompetitorUnitExportRowDto[]> {
    const competitors = await this.prisma.withTenant(
      (tx) =>
        tx.competitorFacility.findMany({
          where: competitorWhere(facilityScope, facilityId),
          orderBy: { name: 'asc' },
          include: {
            facility: { select: { name: true } },
            units: { orderBy: { areaM2: 'asc' } },
          },
        }),
      tenantId,
    );
    return competitors.flatMap((c) =>
      c.units.map((u) => ({
        competitorName: c.name,
        zone: c.zone,
        facilityName: c.facility?.name ?? null,
        distanceKm: c.distanceKm != null ? Number(c.distanceKm) : null,
        areaM2: Number(u.areaM2),
        priceMonthly: Number(u.priceMonthly),
        priceIncludesVat: c.priceIncludesVat,
        comparablePrice: round2(competitorComparablePrice(c, Number(u.priceMonthly))),
        status: u.status as CompetitorUnitStatus,
        externalRef: u.externalRef,
        lastCheckedAt: u.lastCheckedAt.toISOString(),
      })),
    );
  }

  /**
   * Lee con IA el texto de su página de tarifas y propone sus trasteros. No
   * guarda nada: el usuario revisa la propuesta y la aplica.
   */
  async aiParse(
    tenantId: string,
    userId: string,
    competitorFacilityId: string,
    text: string,
    facilityScope?: FacilityScope,
  ): Promise<CompetitorAiParseResultDto> {
    if (!(await this.ai.isAiEnabled(tenantId))) {
      throw new ForbiddenException({
        code: 'feature_not_in_plan',
        message: 'Leer tarifas con IA necesita el asistente IA en tu plan',
        details: { requiredFeature: 'ai_assistant' },
      });
    }
    const competitor = await this.prisma.withTenant(
      (tx) =>
        tx.competitorFacility.findFirst({
          where: { id: competitorFacilityId, ...competitorWhere(facilityScope) },
          select: {
            name: true,
            units: { select: { id: true, areaM2: true, externalRef: true } },
          },
        }),
      tenantId,
    );
    if (!competitor) {
      throw new NotFoundException({
        code: 'competitor_facility_not_found',
        message: 'Local de la competencia no encontrado',
      });
    }
    const raw = await this.ai.completeText({
      tenantId,
      userId,
      feature: 'competitor_parse',
      system: PARSE_SYSTEM,
      user: `Competidor: ${competitor.name}\n\nTexto de su web:\n${text}`,
    });
    let parsed: { units?: unknown[]; notes?: unknown };
    try {
      const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
      parsed = JSON.parse(json) as { units?: unknown[]; notes?: unknown };
    } catch {
      throw new BadRequestException({
        code: 'competitor_parse_failed',
        message: 'No se han podido leer sus trasteros de ese texto. Prueba con otro trozo.',
      });
    }
    const num = (v: unknown) =>
      typeof v === 'number' && Number.isFinite(v) && v > 0 ? round2(v) : null;
    const units: CompetitorUnitProposalDto[] = [];
    for (const item of (parsed.units ?? []).slice(0, 100)) {
      if (!item || typeof item !== 'object') continue;
      const u = item as Record<string, unknown>;
      const price = num(u.priceMonthly);
      const widthM = num(u.widthM);
      const depthM = num(u.depthM);
      const areaM2 = num(u.areaM2) ?? (widthM && depthM ? round2(widthM * depthM) : null);
      if (!price || !areaM2) continue;
      const status = CompetitorUnitStatusEnum.safeParse(u.status);
      const ref =
        typeof u.externalRef === 'string' && u.externalRef.trim()
          ? u.externalRef.trim().slice(0, 60)
          : null;
      // El que ya está fichado con su referencia o con esos m².
      const match =
        competitor.units.find((x) => ref && x.externalRef === ref) ??
        competitor.units.find((x) => Math.abs(Number(x.areaM2) - areaM2) < 0.26);
      units.push({
        areaM2,
        widthM,
        depthM,
        priceMonthly: price,
        status: status.success ? status.data : 'available',
        externalRef: ref,
        matchUnitId: match?.id ?? null,
      });
    }
    return {
      units,
      notes:
        typeof parsed.notes === 'string' && parsed.notes.trim()
          ? parsed.notes.trim().slice(0, 500)
          : null,
    };
  }
}
