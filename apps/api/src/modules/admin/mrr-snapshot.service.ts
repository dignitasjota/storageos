import { Injectable, Logger } from '@nestjs/common';

import {
  chargedWithoutVat,
  currentMrrByTenant,
  dateMonthIndex,
  madridMonthIndex,
  monthIndexDate,
  monthIndexLabel,
  netPaid,
} from '../../common/saas-metrics';
import { platformPricing } from '../billing-saas/platform-pricing';
import { PrismaAdminService } from '../database/prisma-admin.service';

import type {
  AdminMetricsMrrMovementMonthDto,
  AdminMetricsMrrMovementsDto,
  AdminMrrForecastDto,
  AdminMrrForecastPointDto,
} from '@storageos/shared';

const DAY = 86_400_000;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Meses cerrados con datos que hacen falta para proyectar el crecimiento. */
export const FORECAST_MIN_CLOSED_MONTHS = 3;

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
   * Asegura el snapshot de un mes (en hora de España) a partir del **estado
   * actual**: 1 fila por tenant que paga (suscripción activa o atrasada, tenant
   * activo y cuota > 0) con su MRR sin IVA (`tenantMrr`: cuota real con su
   * descuento, la anual entre 12, + extras). En el mes en curso, quien ha dejado
   * de pagar sale del snapshot. Idempotente (upsert por tenant+mes).
   */
  async captureMonth(at: Date): Promise<void> {
    const idx = madridMonthIndex(at);
    const month = monthIndexDate(idx);
    const paying = await currentMrrByTenant(this.admin);
    for (const p of paying.values()) {
      await this.admin.mrrSnapshot.upsert({
        where: { tenantId_month: { tenantId: p.tenantId, month } },
        create: {
          tenantId: p.tenantId,
          month,
          planSlug: p.planSlug,
          status: p.subscriptionStatus,
          mrr: p.total,
        },
        update: { planSlug: p.planSlug, status: p.subscriptionStatus, mrr: p.total },
      });
    }
    if (idx === madridMonthIndex(new Date())) {
      await this.admin.mrrSnapshot.deleteMany({
        where: { month, tenantId: { notIn: [...paying.keys()] } },
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
    const month = monthIndexDate(madridMonthIndex(now));
    const existing = await this.admin.mrrSnapshot.findFirst({
      where: { month },
      select: { id: true },
    });
    if (!existing) await this.captureMonth(now);
  }

  /**
   * Backfill best-effort de los meses pasados desde el historial de pagos:
   * cada pago del plan reparte su importe neto (cobrado − devuelto, sin IVA)
   * entre los meses que cubre (`periodStart..periodEnd`), así que ya lleva el
   * descuento, el ciclo anual y los extras que se cobran con la cuota (SEPA,
   * Redsys, Stripe). Los cobros sueltos de un extra («Add-on: …») suman al mes
   * en que se cobraron. Limitación: un extra que se cobra por Stripe en una
   * factura aparte, o uno que no se ha cobrado todavía, no aparece. Cuenta los
   * pagos `paid` y `partially_refunded` (los devueltos del todo no). Solo CREA
   * snapshots que falten (no pisa los capturados del estado real).
   */
  async backfillFromPayments(monthsBack: number): Promise<number> {
    const nowIdx = madridMonthIndex(new Date());
    const fromIdx = nowIdx - monthsBack;

    const [pricing, payments, existing] = await Promise.all([
      platformPricing(this.admin),
      this.admin.tenantSubscriptionPayment.findMany({
        where: {
          status: { in: ['paid', 'partially_refunded'] },
          planSlug: { not: null },
          periodStart: { not: null },
          tenant: { billingExempt: false },
        },
        select: {
          tenantId: true,
          planSlug: true,
          amount: true,
          refundedAmount: true,
          description: true,
          paidAt: true,
          periodStart: true,
          periodEnd: true,
        },
      }),
      this.admin.mrrSnapshot.findMany({ select: { tenantId: true, month: true } }),
    ]);
    const seen = new Set(existing.map((e) => `${e.tenantId}:${dateMonthIndex(e.month)}`));

    // tenant:mes -> MRR sin IVA y plan.
    const acc = new Map<string, { tenantId: string; idx: number; planSlug: string; mrr: number }>();
    const add = (tenantId: string, idx: number, planSlug: string, amount: number) => {
      // El mes en curso sale del estado real (captureMonth), no de los pagos.
      if (idx < fromIdx || idx >= nowIdx) return;
      const k = `${tenantId}:${idx}`;
      if (seen.has(k)) return;
      const e = acc.get(k) ?? { tenantId, idx, planSlug, mrr: 0 };
      e.mrr += amount;
      acc.set(k, e);
    };
    for (const p of payments) {
      if (!p.planSlug || !p.periodStart) continue;
      const net = chargedWithoutVat(netPaid(p), pricing);
      if (net <= 0) continue;
      if (p.description?.startsWith('Add-on:')) {
        add(p.tenantId, madridMonthIndex(p.paidAt ?? p.periodStart), p.planSlug, net);
        continue;
      }
      const end = p.periodEnd ?? p.periodStart;
      const months = Math.max(
        1,
        Math.round((end.getTime() - p.periodStart.getTime()) / (30.44 * DAY)),
      );
      const first = madridMonthIndex(p.periodStart);
      for (let i = 0; i < months; i++) add(p.tenantId, first + i, p.planSlug, net / months);
    }
    const toCreate = [...acc.values()].map((e) => ({
      tenantId: e.tenantId,
      month: monthIndexDate(e.idx),
      planSlug: e.planSlug,
      status: 'active',
      mrr: round2(e.mrr),
    }));
    // Un solo INSERT en lote en vez de N creates en bucle.
    if (toCreate.length > 0) {
      await this.admin.mrrSnapshot.createMany({ data: toCreate, skipDuplicates: true });
      this.logger.log(`MRR backfill: ${toCreate.length} snapshot(s) creados desde pagos`);
    }
    return toCreate.length;
  }

  /**
   * MRR movements de los últimos `months` meses (en hora de España; el último
   * es el mes en curso). Compara cada mes con el anterior por tenant. Un tenant
   * con el pago atrasado sigue en el snapshot, así que no sale como baja ni
   * como reactivación al pagar.
   */
  async getMovements(months: number): Promise<AdminMetricsMrrMovementsDto> {
    const span = Math.min(Math.max(Math.trunc(months) || 12, 1), 24);
    const now = new Date();
    await this.ensureCurrentMonthSnapshot(now);

    // Un mes extra (el anterior al primero) para el primer delta.
    const nowIdx = madridMonthIndex(now);
    const firstIdx = nowIdx - span;
    const [rows, seenBefore] = await Promise.all([
      this.admin.mrrSnapshot.findMany({
        where: { month: { gte: monthIndexDate(firstIdx) } },
        select: { tenantId: true, month: true, mrr: true },
        orderBy: { month: 'asc' },
      }),
      // Quien tuvo MRR antes de la ventana vuelve como reactivación, no como nuevo.
      this.admin.mrrSnapshot.findMany({
        where: { month: { lt: monthIndexDate(firstIdx) }, mrr: { gt: 0 } },
        select: { tenantId: true },
        distinct: ['tenantId'],
      }),
    ]);

    const byMonth = new Map<number, Map<string, number>>();
    for (const r of rows) {
      const k = dateMonthIndex(r.month);
      if (!byMonth.has(k)) byMonth.set(k, new Map());
      byMonth.get(k)!.set(r.tenantId, Number(r.mrr));
    }

    const everSeen = new Set(seenBefore.map((s) => s.tenantId));
    const result: AdminMetricsMrrMovementMonthDto[] = [];

    let prev = byMonth.get(firstIdx) ?? new Map<string, number>();
    for (const [t, v] of prev) if (v > 0) everSeen.add(t);

    for (let idx = firstIdx + 1; idx <= nowIdx; idx++) {
      const cur = byMonth.get(idx) ?? new Map<string, number>();
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
        label: monthIndexLabel(idx),
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
      (m) =>
        m.newMrr === 0 &&
        m.expansion === 0 &&
        m.churn === 0 &&
        m.contraction === 0 &&
        m.reactivation === 0,
    );
    return { currency: 'EUR', months: result, warmingUp };
  }

  /**
   * Meses cerrados (sin el mes en curso, que está a medias) con datos: los que
   * tenían MRR al empezar o al acabar. Los usan la previsión y el LTV.
   */
  closedMonthsWithData(
    months: AdminMetricsMrrMovementMonthDto[],
  ): (AdminMetricsMrrMovementMonthDto & { baseMrr: number })[] {
    const out: (AdminMetricsMrrMovementMonthDto & { baseMrr: number })[] = [];
    for (let i = 0; i < months.length - 1; i++) {
      const m = months[i]!;
      const baseMrr = i > 0 ? months[i - 1]!.endingMrr : round2(m.endingMrr - m.net);
      if (baseMrr > 0 || m.endingMrr > 0) out.push({ ...m, baseMrr });
    }
    return out;
  }

  /**
   * Previsión de MRR: proyecta `horizonMonths` a partir del histórico de
   * movimientos. La base evoluciona según el NRR medio y se le suman las altas
   * nuevas medias (new + reactivación). Promedia TODOS los meses cerrados con
   * datos (también los que no tuvieron movimiento) y deja fuera el mes en
   * curso. Con menos de 3 meses cerrados no proyecta crecimiento: mantiene el
   * MRR actual y avisa (`insufficientHistory`).
   */
  async getForecast(historyMonths = 12, horizonMonths = 6): Promise<AdminMrrForecastDto> {
    const hist = await this.getMovements(historyMonths);
    const months = hist.months;
    const currentMrr = months.length > 0 ? months[months.length - 1]!.endingMrr : 0;

    const closed = this.closedMonthsWithData(months);
    const basedOnMonths = closed.length;
    const insufficientHistory = basedOnMonths < FORECAST_MIN_CLOSED_MONTHS;
    const avgNewMrr =
      basedOnMonths > 0
        ? round2(closed.reduce((s, m) => s + m.newMrr + m.reactivation, 0) / basedOnMonths)
        : 0;
    const nrrs = closed.map((m) => m.nrr).filter((n): n is number => n !== null);
    const avgNrr = nrrs.length > 0 ? round2(nrrs.reduce((s, n) => s + n, 0) / nrrs.length) : null;

    const horizon = Math.min(Math.max(Math.trunc(horizonMonths) || 6, 1), 24);
    const nowIdx = madridMonthIndex(new Date());
    const points: AdminMrrForecastPointDto[] = [];
    let mrr = currentMrr;
    for (let i = 1; i <= horizon; i++) {
      if (!insufficientHistory) {
        mrr = avgNrr !== null ? mrr * (avgNrr / 100) + avgNewMrr : mrr + avgNewMrr;
      }
      points.push({ label: monthIndexLabel(nowIdx + i), mrr: round2(Math.max(0, mrr)) });
    }

    return {
      currency: 'EUR',
      currentMrr: round2(currentMrr),
      points,
      assumptions: { avgNewMrr, avgNrr, basedOnMonths },
      warmingUp: hist.warmingUp,
      insufficientHistory,
    };
  }
}
