import { Injectable } from '@nestjs/common';

import { ALL_FACILITIES } from '../../analytics/analytics-scope';
import { AnalyticsTrendsService } from '../../analytics/analytics-trends.service';
import { AnalyticsService } from '../../analytics/analytics.service';

import { eur, monthRange } from './new-reports.helpers';

import type { ReportGenerator, ReportGeneratorContext, ReportResult } from './types';

function ym(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function pct(fraction: number, decimals = 1): string {
  return `${(fraction * 100).toLocaleString('es-ES', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })} %`;
}

function change(current: number, previous: number, kind: 'amount' | 'count' | 'rate'): string {
  if (kind === 'rate') {
    const points = (current - previous) * 100;
    if (Math.abs(points) < 0.05) return '=';
    return `${points > 0 ? '+' : ''}${points.toLocaleString('es-ES', { maximumFractionDigits: 1 })} puntos`;
  }
  if (current === previous) return '=';
  if (previous === 0) {
    return kind === 'amount' ? `${eur(current)} más` : `${current} más`;
  }
  const p = Math.round(((current - previous) / previous) * 100);
  return `${p > 0 ? '+' : ''}${p} %`;
}

/**
 * Resumen de un mes de Analítica frente al anterior: facturado, cobrado,
 * ocupación, cuotas, altas, bajas y contactos.
 */
@Injectable()
export class AnalyticsMonthGenerator implements ReportGenerator {
  readonly code = 'analytics_month';
  readonly name = 'Resumen del mes';
  readonly description =
    'Las cifras de un mes frente al anterior: facturado, cobrado, ocupación, cuotas al mes, altas, bajas y contactos.';
  readonly formats = ['pdf', 'xlsx'] as const as ('pdf' | 'xlsx')[];
  readonly paramsSchema = {
    month: { label: 'Mes', type: 'period' as const, required: true },
  };

  constructor(
    private readonly analytics: AnalyticsService,
    private readonly trends: AnalyticsTrendsService,
  ) {}

  async run(ctx: ReportGeneratorContext): Promise<ReportResult> {
    const { start, label } = monthRange(ctx.params.month, 'month');
    const prevStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1));
    const month = ym(start);
    const prev = ym(prevStart);
    const lastDay = (d: Date) =>
      new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const prevLabel = prevStart.toLocaleDateString('es-ES', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
    // Las facturas, solo las del propio negocio (como Analítica por defecto).
    const own = { ...ALL_FACILITIES, issuer: null };
    const now = new Date();
    const monthsBack =
      (now.getUTCFullYear() - prevStart.getUTCFullYear()) * 12 +
      now.getUTCMonth() -
      prevStart.getUTCMonth() +
      1;

    const [revenue, churn, leads, leadsPrev, history] = await Promise.all([
      this.analytics.getMonthlyRevenue(ctx.tenantId, { from: prev, to: month }, own),
      this.analytics.getChurn(ctx.tenantId, { from: prev, to: month }),
      this.analytics.getLeadsFunnel(ctx.tenantId, { from: `${month}-01`, to: lastDay(start) }),
      this.analytics.getLeadsFunnel(ctx.tenantId, {
        from: `${prev}-01`,
        to: lastDay(prevStart),
      }),
      monthsBack <= 36 ? this.trends.getOccupancyHistory(ctx.tenantId, monthsBack) : null,
    ]);

    const point = <T extends { yearMonth: string }>(list: T[], key: string) =>
      list.find((p) => p.yearMonth === key);
    const rev = point(revenue.points, month);
    const revPrev = point(revenue.points, prev);
    const ch = point(churn.months, month);
    const chPrev = point(churn.months, prev);
    const occ = history ? point(history.points, month) : undefined;
    const occPrev = history ? point(history.points, prev) : undefined;

    type Row = { label: string; cur: number; prev: number; kind: 'amount' | 'count' | 'rate' };
    const figures: Row[] = [];
    if (rev && revPrev) {
      figures.push({
        label: 'Facturado (con IVA)',
        cur: rev.invoiced,
        prev: revPrev.invoiced,
        kind: 'amount',
      });
      figures.push({
        label: 'Cobrado',
        cur: rev.collected,
        prev: revPrev.collected,
        kind: 'amount',
      });
    }
    if (occ && occPrev) {
      figures.push({
        label: 'Ocupación al cerrar',
        cur: occ.occupancy,
        prev: occPrev.occupancy,
        kind: 'rate',
      });
      if (occ.mrr !== null && occPrev.mrr !== null) {
        figures.push({
          label: 'Cuotas al mes al cerrar',
          cur: occ.mrr,
          prev: occPrev.mrr,
          kind: 'amount',
        });
      }
    }
    if (ch && chPrev) {
      figures.push({ label: 'Altas', cur: ch.started, prev: chPrev.started, kind: 'count' });
      figures.push({ label: 'Bajas', cur: ch.ended, prev: chPrev.ended, kind: 'count' });
      figures.push({
        label: 'Tasa de bajas',
        cur: ch.churnRate,
        prev: chPrev.churnRate,
        kind: 'rate',
      });
    }
    figures.push({
      label: 'Contactos recibidos',
      cur: leads.total,
      prev: leadsPrev.total,
      kind: 'count',
    });
    figures.push({
      label: 'Contactos ganados',
      cur: leads.reached.won,
      prev: leadsPrev.reached.won,
      kind: 'count',
    });

    const show = (r: Row, v: number) =>
      r.kind === 'amount' ? eur(v) : r.kind === 'rate' ? pct(v) : String(v);

    return {
      title: `Resumen de ${label}`,
      subtitle: `Frente a ${prevLabel}`,
      generatedAt: new Date(),
      columns: [
        { key: 'label', label: 'Cifra', width: 30 },
        { key: 'current', label: label, width: 18, align: 'right' },
        { key: 'previous', label: prevLabel, width: 18, align: 'right' },
        { key: 'change', label: 'Variación', width: 16, align: 'right' },
      ],
      rows: figures.map((r) => ({
        label: r.label,
        current: show(r, r.cur),
        previous: show(r, r.prev),
        change: change(r.cur, r.prev, r.kind),
      })),
    };
  }
}
