import { Injectable } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';

import { computeMetric } from './benchmark.util';

import type { BenchmarkDto } from '@storageos/shared';

/**
 * Muestra mínima de operadores para publicar agregados del sector. Por debajo
 * de este umbral la comparativa NO se devuelve (`available:false`) para
 * garantizar el anonimato: con pocos operadores, una mediana/percentil podría
 * revelar el dato de un competidor concreto.
 */
const MIN_SAMPLE = 5;

interface TenantAgg {
  total: number;
  occupied: number;
  priceSum: number;
  priceCount: number;
  sqmSum: number;
  sqmCount: number;
}

/**
 * Benchmarking anónimo entre tenants. Agrega ocupación/precio/€m² de TODOS los
 * operadores activos y le devuelve al tenant que consulta sólo los agregados del
 * sector (mediana/p25/p75/tamaño de muestra) + sus propios valores y percentil.
 *
 * Usa `PrismaAdminService` (bypass RLS) porque necesita datos cross-tenant, pero
 * SÓLO produce agregados anónimos: nunca ids, nombres ni valores individuales de
 * otros operadores salen de este servicio.
 */
@Injectable()
export class BenchmarkService {
  constructor(private readonly admin: PrismaAdminService) {}

  async getBenchmark(tenantId: string): Promise<BenchmarkDto> {
    // Cargamos las units de operadores activos (no borrados) con un `select`
    // MÍNIMO (4 columnas) y agregamos en JS por tenant. A escala de cientos de
    // operadores × units es asumible; si la plataforma creciera mucho, esto se
    // migraría a agregados SQL o a una tabla materializada periódica.
    const units = await this.admin.unit.findMany({
      where: { tenant: { deletedAt: null, status: { in: ['active', 'trial'] } } },
      select: { tenantId: true, status: true, basePriceMonthly: true, areaM2: true },
    });

    const byTenant = new Map<string, TenantAgg>();
    for (const u of units) {
      let agg = byTenant.get(u.tenantId);
      if (!agg) {
        agg = { total: 0, occupied: 0, priceSum: 0, priceCount: 0, sqmSum: 0, sqmCount: 0 };
        byTenant.set(u.tenantId, agg);
      }
      agg.total += 1;
      if (u.status === 'occupied') agg.occupied += 1;
      const price = Number(u.basePriceMonthly);
      if (Number.isFinite(price)) {
        agg.priceSum += price;
        agg.priceCount += 1;
        const area = u.areaM2 == null ? 0 : Number(u.areaM2);
        if (Number.isFinite(area) && area > 0) {
          agg.sqmSum += price / area;
          agg.sqmCount += 1;
        }
      }
    }

    // Un valor por operador para cada métrica. Ocupación/precio: todos los que
    // tienen ≥1 trastero. €/m²: sólo los que tienen trasteros con superficie > 0.
    const occVec: number[] = [];
    const priceVec: number[] = [];
    const sqmVec: number[] = [];
    let mineOcc = 0;
    let minePrice = 0;
    let mineSqm = 0;
    let mineHasSqm = false;

    for (const [tid, agg] of byTenant) {
      if (agg.total === 0) continue;
      const occ = agg.occupied / agg.total;
      const avgPrice = agg.priceCount > 0 ? agg.priceSum / agg.priceCount : 0;
      occVec.push(occ);
      priceVec.push(avgPrice);
      const avgSqm = agg.sqmCount > 0 ? agg.sqmSum / agg.sqmCount : null;
      if (avgSqm != null) sqmVec.push(avgSqm);
      if (tid === tenantId) {
        mineOcc = occ;
        minePrice = avgPrice;
        if (avgSqm != null) {
          mineHasSqm = true;
          mineSqm = avgSqm;
        }
      }
    }

    const sampleSize = occVec.length;
    if (sampleSize < MIN_SAMPLE) {
      // Muestra insuficiente: no publicamos agregados (anonimato).
      return { available: false, sampleSize };
    }

    // Ocupación en % (0-100 en la respuesta, el vector interno es fracción 0-1).
    const occupancy = computeMetric(
      occVec.map((v) => v * 100),
      mineOcc * 100,
    );
    const price = computeMetric(priceVec, minePrice);

    return {
      available: true,
      sampleSize,
      occupancy,
      price,
      // €/m² sólo si su propio vector alcanza el mínimo y el tenant tiene dato.
      ...(sqmVec.length >= MIN_SAMPLE && mineHasSqm
        ? { pricePerSqm: computeMetric(sqmVec, mineSqm) }
        : {}),
    };
  }
}
