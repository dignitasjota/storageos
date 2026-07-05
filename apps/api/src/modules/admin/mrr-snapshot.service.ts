import { Injectable, Logger } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type {
  AdminMetricsMrrMovementMonthDto,
  AdminMetricsMrrMovementsDto,
  AdminMrrForecastDto,
  AdminMrrForecastPointDto,
} from '@storageos/shared';

const MONTHS_ES = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
];

/** Primer día del mes (UTC) de una fecha. */
function startOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function addMonthsUtc(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

/** Clave estable de un mes: "YYYY-MM" (a partir de su primer día UTC). */
function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(d: Date): string {
  return `${MONTHS_ES[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Snapshots mensuales de MRR + cálculo de los MRR movements.
 *
 * Por qué snapshots: el MRR movements (new/expansion/contraction/churn/
 * reactivation) necesita saber el MRR de CADA tenant en CADA mes pasado, y la
 * suscripción solo guarda el estado actual. Cada mes se persiste una foto del
 * MRR por tenant; comparando meses consecutivos se derivan los movimientos.
 */
@Injectable()
export class MrrSnapshotService {
  private readonly logger = new Logger(MrrSnapshotService.name);

  constructor(private readonly admin: PrismaAdminService) {}

  /**
   * Asegura el snapshot de un mes a partir del **estado actual** de las
   * suscripciones (1 fila por tenant con suscripción `active`, MRR =
   * priceMonthly del plan). Idempotente (upsert por tenant+mes).
   */
  async captureMonth(monthStart: Date): Promise<void> {
    const month = startOfMonthUtc(monthStart);
    const subs = await this.admin.tenantSubscription.findMany({
      where: { status: 'active', tenant: { deletedAt: null } },
      select: { tenantId: true, plan: { select: { slug: true, priceMonthly: true } } },
    });
    for (const s of subs) {
      const mrr = Number(s.plan.priceMonthly);
      await this.admin.mrrSnapshot.upsert({
        where: { tenantId_month: { tenantId: s.tenantId, month } },
        create: { tenantId: s.tenantId, month, planSlug: s.plan.slug, status: 'active', mrr },
        update: { planSlug: s.plan.slug, status: 'active', mrr },
      });
    }
  }

  /**
   * Asegura que existe el snapshot del mes en curso SIN reescribir en cada GET:
   * si ya hay al menos una fila de este mes (la puso el cron diario o un GET
   * previo), no hace nada. Solo la primera consulta del mes dispara la captura.
   * El refresco intramensual (cambios de plan) lo hace el cron diario.
   */
  private async ensureCurrentMonthSnapshot(now: Date): Promise<void> {
    const month = startOfMonthUtc(now);
    const existing = await this.admin.mrrSnapshot.findFirst({
      where: { month },
      select: { id: true },
    });
    if (!existing) await this.captureMonth(now);
  }

  /**
   * Backfill best-effort de los meses pasados desde el historial de pagos SaaS:
   * cada pago (planSlug + periodStart..periodEnd) implica MRR `active` en los
   * meses que cubre. Solo CREA snapshots que falten (no pisa los ya capturados
   * del estado real). Permite mostrar movimientos sin esperar meses, cuando hay
   * pagos registrados.
   */
  async backfillFromPayments(monthsBack: number): Promise<number> {
    const now = new Date();
    const from = addMonthsUtc(startOfMonthUtc(now), -monthsBack);

    const [plans, payments, existing] = await Promise.all([
      this.admin.subscriptionPlan.findMany({ select: { slug: true, priceMonthly: true } }),
      this.admin.tenantSubscriptionPayment.findMany({
        where: { status: 'paid', planSlug: { not: null }, periodStart: { not: null } },
        select: { tenantId: true, planSlug: true, periodStart: true, periodEnd: true },
      }),
      this.admin.mrrSnapshot.findMany({ select: { tenantId: true, month: true } }),
    ]);
    const priceBySlug = new Map(plans.map((p) => [p.slug, Number(p.priceMonthly)]));
    const seen = new Set(existing.map((e) => `${e.tenantId}:${monthKey(e.month)}`));

    const toCreate: {
      tenantId: string;
      month: Date;
      planSlug: string;
      status: string;
      mrr: number;
    }[] = [];
    for (const p of payments) {
      if (!p.planSlug || !p.periodStart) continue;
      const price = priceBySlug.get(p.planSlug);
      if (price === undefined) continue;
      const end = p.periodEnd ?? p.periodStart;
      // Meses cubiertos por el periodo del pago (acota a la ventana).
      let m = startOfMonthUtc(p.periodStart);
      const endMonth = startOfMonthUtc(end);
      while (m <= endMonth) {
        if (m >= from && m <= startOfMonthUtc(now)) {
          const k = `${p.tenantId}:${monthKey(m)}`;
          if (!seen.has(k)) {
            seen.add(k);
            toCreate.push({
              tenantId: p.tenantId,
              month: m,
              planSlug: p.planSlug,
              status: 'active',
              mrr: price,
            });
          }
        }
        m = addMonthsUtc(m, 1);
      }
    }
    // Un solo INSERT en lote en vez de N creates en bucle.
    if (toCreate.length > 0) {
      await this.admin.mrrSnapshot.createMany({ data: toCreate, skipDuplicates: true });
      this.logger.log(`MRR backfill: ${toCreate.length} snapshot(s) creados desde pagos`);
    }
    return toCreate.length;
  }

  /**
   * MRR movements de los últimos `months` meses. Asegura el snapshot del mes en
   * curso + backfill, luego compara cada mes con el anterior por tenant.
   */
  async getMovements(months: number): Promise<AdminMetricsMrrMovementsDto> {
    const span = Math.min(Math.max(months, 1), 24);
    const now = new Date();
    // Rendimiento: antes cada GET hacía captureMonth (1 upsert por suscripción,
    // ~500 escrituras) + backfillFromPayments (full-scan + creates en bucle), y
    // la página Métricas lo dispara DOS veces (movements + forecast lo reusa).
    // Ahora el backfill/refresco lo hace el cron (diario) y aquí solo aseguramos
    // que EXISTE el snapshot del mes en curso (una vez por mes; guard barato).
    await this.ensureCurrentMonthSnapshot(now);

    // Necesitamos un mes extra (el anterior al primero) para el primer delta.
    const firstMonth = addMonthsUtc(startOfMonthUtc(now), -span);
    const rows = await this.admin.mrrSnapshot.findMany({
      where: { month: { gte: firstMonth } },
      select: { tenantId: true, month: true, mrr: true },
      orderBy: { month: 'asc' },
    });

    // month -> (tenantId -> mrr)
    const byMonth = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const k = monthKey(r.month);
      if (!byMonth.has(k)) byMonth.set(k, new Map());
      byMonth.get(k)!.set(r.tenantId, Number(r.mrr));
    }

    const monthsList = Array.from({ length: span + 1 }, (_, i) => addMonthsUtc(firstMonth, i));
    const everSeen = new Set<string>();
    const result: AdminMetricsMrrMovementMonthDto[] = [];

    // El primer mes solo siembra `everSeen` (no tiene mes anterior con datos).
    let prev = byMonth.get(monthKey(monthsList[0]!)) ?? new Map<string, number>();
    for (const t of prev.keys()) everSeen.add(t);

    for (let i = 1; i < monthsList.length; i++) {
      const cur = byMonth.get(monthKey(monthsList[i]!)) ?? new Map<string, number>();
      let newMrr = 0;
      let expansion = 0;
      let reactivation = 0;
      let contraction = 0;
      let churn = 0;
      let endingMrr = 0;
      let baseMrr = 0;

      for (const prevMrr of prev.values()) baseMrr += prevMrr;

      const tenants = new Set([...prev.keys(), ...cur.keys()]);
      for (const t of tenants) {
        const before = prev.get(t) ?? 0;
        const after = cur.get(t) ?? 0;
        endingMrr += after;
        if (before === 0 && after > 0) {
          if (everSeen.has(t)) reactivation += after;
          else newMrr += after;
        } else if (before > 0 && after === 0) {
          churn += before;
        } else if (after > before) {
          expansion += after - before;
        } else if (after < before) {
          contraction += before - after;
        }
        if (after > 0) everSeen.add(t);
      }

      const net = newMrr + expansion + reactivation - contraction - churn;
      const nrr =
        baseMrr > 0 ? round2(((baseMrr - churn - contraction + expansion) / baseMrr) * 100) : null;
      result.push({
        label: monthLabel(monthsList[i]!),
        newMrr: round2(newMrr),
        expansion: round2(expansion),
        reactivation: round2(reactivation),
        contraction: round2(contraction),
        churn: round2(churn),
        net: round2(net),
        endingMrr: round2(endingMrr),
        nrr,
      });
      prev = cur;
    }

    // "warmingUp": no hay ningún movimiento en ningún mes (faltan snapshots).
    const warmingUp = result.every(
      (m) => m.newMrr === 0 && m.expansion === 0 && m.churn === 0 && m.contraction === 0,
    );
    return { currency: 'EUR', months: result, warmingUp };
  }

  /**
   * Previsión de MRR: proyecta `horizonMonths` a partir del histórico de
   * movimientos. La base existente evoluciona según el NRR medio (retención +
   * expansión − contracción − churn) y se le suman las altas nuevas medias
   * (new + reactivación). Modelo simple y transparente (expone los supuestos).
   */
  async getForecast(historyMonths = 12, horizonMonths = 6): Promise<AdminMrrForecastDto> {
    const hist = await this.getMovements(historyMonths);
    const months = hist.months;
    const currentMrr = months.length > 0 ? months[months.length - 1]!.endingMrr : 0;

    // Solo los meses con actividad promedian las altas nuevas.
    const active = months.filter(
      (m) =>
        m.newMrr !== 0 ||
        m.expansion !== 0 ||
        m.churn !== 0 ||
        m.contraction !== 0 ||
        m.reactivation !== 0,
    );
    const basedOnMonths = active.length;
    const avgNewMrr =
      basedOnMonths > 0
        ? round2(active.reduce((s, m) => s + m.newMrr + m.reactivation, 0) / basedOnMonths)
        : 0;
    const nrrs = months.map((m) => m.nrr).filter((n): n is number => n !== null);
    const avgNrr = nrrs.length > 0 ? round2(nrrs.reduce((s, n) => s + n, 0) / nrrs.length) : null;

    const horizon = Math.min(Math.max(horizonMonths, 1), 24);
    const now = new Date();
    const nowMonth = startOfMonthUtc(now);
    const points: AdminMrrForecastPointDto[] = [];
    let mrr = currentMrr;
    for (let i = 1; i <= horizon; i++) {
      mrr = avgNrr !== null ? mrr * (avgNrr / 100) + avgNewMrr : mrr + avgNewMrr;
      points.push({ label: monthLabel(addMonthsUtc(nowMonth, i)), mrr: round2(Math.max(0, mrr)) });
    }

    return {
      currency: 'EUR',
      currentMrr: round2(currentMrr),
      points,
      assumptions: { avgNewMrr, avgNrr, basedOnMonths },
      warmingUp: hist.warmingUp,
    };
  }
}
