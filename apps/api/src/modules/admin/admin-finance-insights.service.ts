import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  FINANCE_CSV_KINDS,
  gatewayFee,
  MONTH_PARAM_REGEX,
  paybackMonths,
  quarterOfMonth,
  type AdminAcquisitionDto,
  type AdminAcquisitionMonthDto,
  type AdminCashMonthDto,
  type AdminFinanceCsvKind,
  type AdminFinanceSettingsDto,
  type AdminMarginDto,
  type AdminMarginMonthDto,
  type AdminTenantMarginDto,
  type AdminVatQuarterlyDto,
  type UpdateFinanceSettingsInput,
  type UpdateMarketingSpendInput,
} from '@storageos/shared';

import { aiCostUsd } from '../../common/ai-pricing';
import { csvCell } from '../../common/csv';
import { loadPuppeteer } from '../../common/puppeteer';
import {
  chargedWithoutVat,
  COLLECTED_PAYMENT_STATUSES,
  currentMrrByTenant,
  financeSource,
  loadPayerLifecycles,
  madridMonthIndex,
  monthIndexKey,
  monthIndexLabel,
  monthIndexStart,
  netPaid,
  OWN_KEY_AI_FEATURES,
} from '../../common/saas-metrics';
import { platformPricing } from '../billing-saas/platform-pricing';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { AdminBillingOpsService } from './admin-billing-ops.service';
import { AdminFinanceService } from './admin-finance.service';

import type { Env } from '../../config/env.schema';

const round2 = (n: number): number => Math.round(n * 100) / 100;
const MONTHS_LONG_ES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** «3.427,00 €». */
const eur = (n: number) => {
  const [int, dec] = Math.abs(n).toFixed(2).split('.') as [string, string];
  return `${n < 0 ? '−' : ''}${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec} €`;
};
const pctText = (n: number | null) => (n === null ? '—' : `${n.toFixed(1).replace('.', ',')} %`);
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const toCsv = (rows: (string | number | null)[][]) =>
  `${String.fromCharCode(0xfeff)}${rows.map((r) => r.map(csvCell).join(';')).join('\n')}\n`;

const PROVIDER_LABELS: Record<string, string> = {
  stripe: 'Stripe',
  cash: 'Efectivo',
  bank_transfer: 'Transferencia',
  paypal: 'PayPal',
  other: 'Otro',
  manual: 'Manual',
  sepa: 'Remesa SEPA',
  redsys: 'Redsys (tarjeta o Bizum)',
};

/**
 * Lo nuevo de Finanzas: ajustes de costes, IVA repercutido por trimestre,
 * margen (ingresos sin IVA menos comisiones de pasarela, IA, correo y
 * comerciales), coste de adquisición y recuperación, caja del mes frente al
 * objetivo, exportaciones (CSV y PDF).
 *
 * Costes estimados (las pasarelas no nos dan su comisión real por cobro): un %
 * del cobro más un fijo por cobro, por forma de cobro; la IA en dólares se pasa
 * a euros con un cambio fijo configurable; el correo, un coste por correo.
 */
@Injectable()
export class AdminFinanceInsightsService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly config: ConfigService<Env, true>,
    private readonly finance: AdminFinanceService,
    private readonly billingOps: AdminBillingOpsService,
  ) {}

  // --- Ajustes de costes -----------------------------------------------------

  private async settingsRow() {
    const row = await this.admin.platformFinanceSettings.findFirst();
    return row ?? this.admin.platformFinanceSettings.create({ data: {} });
  }

  async getSettings(): Promise<AdminFinanceSettingsDto> {
    const r = await this.settingsRow();
    return {
      stripeFeePct: Number(r.stripeFeePct),
      stripeFeeFixed: Number(r.stripeFeeFixed),
      redsysFeePct: Number(r.redsysFeePct),
      redsysFeeFixed: Number(r.redsysFeeFixed),
      sepaFeePct: Number(r.sepaFeePct),
      sepaFeeFixed: Number(r.sepaFeeFixed),
      manualFeePct: Number(r.manualFeePct),
      manualFeeFixed: Number(r.manualFeeFixed),
      usdEurRate: Number(r.usdEurRate),
      emailCost: Number(r.emailCost),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  async updateSettings(input: UpdateFinanceSettingsInput): Promise<AdminFinanceSettingsDto> {
    const row = await this.settingsRow();
    const data: Record<string, number> = {};
    for (const [k, v] of Object.entries(input)) if (typeof v === 'number') data[k] = v;
    await this.admin.platformFinanceSettings.update({ where: { id: row.id }, data });
    return this.getSettings();
  }

  // --- IVA repercutido por trimestre ---------------------------------------------

  /**
   * IVA de las facturas de suscripción emitidas en el año (hora de España), por
   * trimestre natural y por tipo. Las sustituidas no cuentan (ya están en su
   * sustitutiva); las rectificativas restan.
   */
  async vatQuarterly(year: number): Promise<AdminVatQuarterlyDto> {
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException({ code: 'invalid_year', message: 'Año no válido' });
    }
    const invoices = await this.admin.platformInvoice.findMany({
      where: {
        issuedAt: { gte: monthIndexStart(year * 12), lt: monthIndexStart((year + 1) * 12) },
        status: { not: 'rectified' },
      },
      select: { issuedAt: true, baseAmount: true, taxAmount: true, total: true, taxRate: true },
    });
    const quarters = ([1, 2, 3, 4] as const).map((quarter) => ({
      quarter,
      label: `${quarter}T ${year}`,
      invoices: 0,
      base: 0,
      tax: 0,
      total: 0,
      rates: new Map<number, { base: number; tax: number; total: number }>(),
    }));
    for (const inv of invoices) {
      const q = quarters[quarterOfMonth((madridMonthIndex(inv.issuedAt) % 12) + 1) - 1]!;
      const base = Number(inv.baseAmount);
      const tax = Number(inv.taxAmount);
      const total = Number(inv.total);
      q.invoices += 1;
      q.base += base;
      q.tax += tax;
      q.total += total;
      const rate = Number(inv.taxRate);
      const r = q.rates.get(rate) ?? { base: 0, tax: 0, total: 0 };
      r.base += base;
      r.tax += tax;
      r.total += total;
      q.rates.set(rate, r);
    }
    const out = quarters.map((q) => ({
      quarter: q.quarter,
      label: q.label,
      invoices: q.invoices,
      base: round2(q.base),
      tax: round2(q.tax),
      total: round2(q.total),
      byRate: [...q.rates.entries()]
        .map(([rate, r]) => ({
          rate,
          base: round2(r.base),
          tax: round2(r.tax),
          total: round2(r.total),
        }))
        .sort((a, b) => b.rate - a.rate),
    }));
    return {
      year,
      quarters: out,
      totals: {
        invoices: out.reduce((s, q) => s + q.invoices, 0),
        base: round2(out.reduce((s, q) => s + q.base, 0)),
        tax: round2(out.reduce((s, q) => s + q.tax, 0)),
        total: round2(out.reduce((s, q) => s + q.total, 0)),
      },
    };
  }

  // --- Margen ---------------------------------------------------------------------

  /**
   * Margen por mes: cobrado neto sin IVA menos la comisión estimada de cada
   * cobro, el coste de la IA de la plataforma (en euros), el correo enviado (de
   * la plataforma y de los tenants) y las comisiones de los comerciales
   * aprobadas de ese mes. También por tenant (los 10 mejores y peores).
   */
  async margin(months: number): Promise<AdminMarginDto> {
    return (await this.marginData(months)).dto;
  }

  /** Margen de cada tenant en los últimos `months` meses (todos, no solo los 10 primeros). */
  async tenantMargins(months: number): Promise<Map<string, AdminTenantMarginDto>> {
    const { perTenant } = await this.marginData(months);
    return new Map(perTenant.map((t) => [t.tenantId, t]));
  }

  private async marginData(
    months: number,
  ): Promise<{ dto: AdminMarginDto; perTenant: AdminTenantMarginDto[] }> {
    const nowIdx = madridMonthIndex(new Date());
    const firstIdx = nowIdx - (months - 1);
    const from = monthIndexStart(firstIdx);
    const monthKeys = Array.from({ length: months }, (_, i) => monthIndexKey(firstIdx + i));
    const [settings, pricing, payments, aiRows, platformEmails, tenantEmails, commissions] =
      await Promise.all([
        this.getSettings(),
        platformPricing(this.admin),
        this.admin.tenantSubscriptionPayment.findMany({
          where: {
            status: { in: [...COLLECTED_PAYMENT_STATUSES] },
            paidAt: { gte: from },
            tenant: { billingExempt: false },
          },
          select: {
            tenantId: true,
            paidAt: true,
            amount: true,
            refundedAmount: true,
            provider: true,
          },
        }),
        this.admin.$queryRaw<
          { tenant_id: string; m: string; model: string; i: bigint; o: bigint }[]
        >`
          SELECT tenant_id::text AS tenant_id,
                 to_char(created_at AT TIME ZONE 'Europe/Madrid', 'YYYY-MM') AS m,
                 model,
                 COALESCE(SUM(input_tokens), 0)::bigint AS i,
                 COALESCE(SUM(output_tokens), 0)::bigint AS o
          FROM ai_usage_events
          WHERE created_at >= ${from}
            AND counts_as_query = false
            AND own_key = false
            AND NOT (feature = ANY(${OWN_KEY_AI_FEATURES}))
          GROUP BY 1, 2, 3`,
        this.admin.$queryRaw<{ tenant_id: string | null; m: string; n: bigint }[]>`
          SELECT tenant_id::text AS tenant_id,
                 to_char(created_at AT TIME ZONE 'Europe/Madrid', 'YYYY-MM') AS m,
                 COUNT(*)::bigint AS n
          FROM platform_email_logs
          WHERE created_at >= ${from} AND status IN ('sent', 'delivered', 'bounced')
          GROUP BY 1, 2`,
        this.admin.$queryRaw<{ tenant_id: string; m: string; n: bigint }[]>`
          SELECT tenant_id::text AS tenant_id,
                 to_char(sent_at AT TIME ZONE 'Europe/Madrid', 'YYYY-MM') AS m,
                 COUNT(*)::bigint AS n
          FROM communications
          WHERE sent_at >= ${from} AND channel = 'email'
            AND status IN ('sent', 'delivered', 'bounced')
          GROUP BY 1, 2`,
        this.admin.salesCommissionItem.findMany({
          where: { month: { in: monthKeys }, status: 'approved' },
          select: { tenantId: true, month: true, amount: true },
        }),
      ]);

    const fees = {
      stripe: [settings.stripeFeePct, settings.stripeFeeFixed],
      sepa: [settings.sepaFeePct, settings.sepaFeeFixed],
      redsys: [settings.redsysFeePct, settings.redsysFeeFixed],
      manual: [settings.manualFeePct, settings.manualFeeFixed],
    } as const;
    // Coste de la IA con el precio de cada modelo (`ai-pricing.ts`).
    const aiFallback = {
      inputPerMTokUsd: this.config.get('AI_COST_INPUT_PER_MTOK_USD', { infer: true }),
      outputPerMTokUsd: this.config.get('AI_COST_OUTPUT_PER_MTOK_USD', { infer: true }),
    };

    type Costs = {
      revenue: number;
      gatewayFees: number;
      aiCost: number;
      emailCost: number;
      salesCommissions: number;
    };
    const empty = (): Costs => ({
      revenue: 0,
      gatewayFees: 0,
      aiCost: 0,
      emailCost: 0,
      salesCommissions: 0,
    });
    const byMonth = new Map(monthKeys.map((k) => [k, empty()]));
    const byTenant = new Map<string, Costs>();
    const addTo = (month: string, tenantId: string | null, field: keyof Costs, v: number) => {
      const m = byMonth.get(month);
      if (!m) return;
      m[field] += v;
      if (!tenantId) return;
      const t = byTenant.get(tenantId) ?? empty();
      t[field] += v;
      byTenant.set(tenantId, t);
    };

    for (const p of payments) {
      if (!p.paidAt) continue;
      const month = monthIndexKey(madridMonthIndex(p.paidAt));
      const [pct, fixed] = fees[financeSource(p.provider)];
      addTo(month, p.tenantId, 'revenue', chargedWithoutVat(netPaid(p), pricing));
      addTo(month, p.tenantId, 'gatewayFees', gatewayFee(Number(p.amount), pct, fixed));
    }
    for (const r of aiRows) {
      const usd = aiCostUsd(r.model, Number(r.i), Number(r.o), aiFallback);
      addTo(r.m, r.tenant_id, 'aiCost', usd * settings.usdEurRate);
    }
    let emailsSent = 0;
    for (const r of [...platformEmails, ...tenantEmails]) {
      const n = Number(r.n);
      if (byMonth.has(r.m)) emailsSent += n;
      addTo(r.m, r.tenant_id, 'emailCost', n * settings.emailCost);
    }
    for (const c of commissions) {
      addTo(c.month, c.tenantId, 'salesCommissions', Number(c.amount));
    }

    const finish = (c: Costs) => {
      const costs = c.gatewayFees + c.aiCost + c.emailCost + c.salesCommissions;
      const margin = c.revenue - costs;
      return {
        revenue: round2(c.revenue),
        gatewayFees: round2(c.gatewayFees),
        aiCost: round2(c.aiCost),
        emailCost: round2(c.emailCost),
        salesCommissions: round2(c.salesCommissions),
        margin: round2(margin),
        marginPct: c.revenue > 0 ? round2((margin / c.revenue) * 100) : null,
      };
    };
    const monthly: AdminMarginMonthDto[] = monthKeys.map((month, i) => ({
      label: monthIndexLabel(firstIdx + i),
      month,
      ...finish(byMonth.get(month)!),
    }));
    const sum = empty();
    for (const m of byMonth.values()) {
      for (const k of Object.keys(sum) as (keyof Costs)[]) sum[k] += m[k];
    }
    const grossMarginPct =
      sum.revenue > 0
        ? round2(((sum.revenue - sum.gatewayFees - sum.aiCost - sum.emailCost) / sum.revenue) * 100)
        : null;

    const tenantIds = [...byTenant.keys()];
    const names =
      tenantIds.length > 0
        ? await this.admin.tenant.findMany({
            where: { id: { in: tenantIds }, billingExempt: false },
            select: { id: true, name: true, slug: true },
          })
        : [];
    const perTenant: AdminTenantMarginDto[] = names.map((t) => {
      const c = finish(byTenant.get(t.id)!);
      return {
        tenantId: t.id,
        name: t.name,
        slug: t.slug,
        revenue: c.revenue,
        costs: round2(c.gatewayFees + c.aiCost + c.emailCost + c.salesCommissions),
        margin: c.margin,
        marginPct: c.marginPct,
      };
    });
    const sorted = [...perTenant].sort((a, b) => b.margin - a.margin);
    return {
      perTenant,
      dto: {
        months,
        settings,
        monthly,
        totals: finish(sum),
        grossMarginPct,
        emailsSent,
        topTenants: sorted.slice(0, 10),
        worstTenants: [...sorted].reverse().slice(0, 10),
      },
    };
  }

  // --- Coste de adquisición ------------------------------------------------------

  async listMarketingSpend(
    months: number,
  ): Promise<{ month: string; amount: number; note: string | null }[]> {
    const nowIdx = madridMonthIndex(new Date());
    const keys = Array.from({ length: months }, (_, i) => monthIndexKey(nowIdx - (months - 1) + i));
    const rows = await this.admin.platformMarketingSpend.findMany({
      where: { month: { in: keys } },
    });
    const by = new Map(rows.map((r) => [r.month, r]));
    return keys.map((month) => ({
      month,
      amount: round2(Number(by.get(month)?.amount ?? 0)),
      note: by.get(month)?.note ?? null,
    }));
  }

  async setMarketingSpend(
    month: string,
    input: UpdateMarketingSpendInput,
  ): Promise<{ month: string; amount: number; note: string | null }> {
    if (!MONTH_PARAM_REGEX.test(month)) {
      throw new BadRequestException({ code: 'invalid_month', message: 'Mes AAAA-MM' });
    }
    const row = await this.admin.platformMarketingSpend.upsert({
      where: { month },
      create: { month, amount: input.amount, note: input.note ?? null },
      update: {
        amount: input.amount,
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
    });
    return { month, amount: round2(Number(row.amount)), note: row.note };
  }

  /**
   * Coste de adquisición por mes: comisiones de venta de los comerciales
   * (partidas `sale` aprobadas del mes) + gasto de marketing de ese mes, entre
   * los clientes que pagaron por primera vez ese mes. Recuperación = CAC /
   * (ARPA × margen bruto del periodo).
   */
  async acquisition(months: number): Promise<AdminAcquisitionDto> {
    const nowIdx = madridMonthIndex(new Date());
    const firstIdx = nowIdx - (months - 1);
    const keys = Array.from({ length: months }, (_, i) => monthIndexKey(firstIdx + i));
    const [payers, sales, marketing, paying, margin] = await Promise.all([
      loadPayerLifecycles(this.admin),
      this.admin.salesCommissionItem.groupBy({
        by: ['month'],
        where: { month: { in: keys }, status: 'approved', kind: 'sale' },
        _sum: { amount: true },
      }),
      this.admin.platformMarketingSpend.findMany({ where: { month: { in: keys } } }),
      currentMrrByTenant(this.admin),
      this.margin(months),
    ]);
    const newBy = new Map<string, number>();
    for (const p of payers) {
      const k = monthIndexKey(madridMonthIndex(p.firstPaidAt));
      newBy.set(k, (newBy.get(k) ?? 0) + 1);
    }
    const salesBy = new Map(sales.map((s) => [s.month, Number(s._sum.amount ?? 0)]));
    const marketingBy = new Map(marketing.map((m) => [m.month, Number(m.amount)]));
    const cacOf = (spend: number, n: number) => (n > 0 ? round2(spend / n) : null);
    const monthly: AdminAcquisitionMonthDto[] = keys.map((month, i) => {
      const newPaying = newBy.get(month) ?? 0;
      const salesSpend = round2(salesBy.get(month) ?? 0);
      const marketingSpend = round2(marketingBy.get(month) ?? 0);
      return {
        label: monthIndexLabel(firstIdx + i),
        month,
        newPaying,
        salesSpend,
        marketingSpend,
        cac: cacOf(salesSpend + marketingSpend, newPaying),
      };
    });
    const totals = {
      newPaying: monthly.reduce((s, m) => s + m.newPaying, 0),
      salesSpend: round2(monthly.reduce((s, m) => s + m.salesSpend, 0)),
      marketingSpend: round2(monthly.reduce((s, m) => s + m.marketingSpend, 0)),
      cac: null as number | null,
    };
    totals.cac = cacOf(totals.salesSpend + totals.marketingSpend, totals.newPaying);
    let mrr = 0;
    for (const p of paying.values()) mrr += p.total;
    const arpa = paying.size > 0 ? round2(mrr / paying.size) : 0;
    return {
      months,
      monthly,
      totals,
      arpa,
      grossMarginPct: margin.grossMarginPct,
      paybackMonths: paybackMonths(totals.cac, arpa, margin.grossMarginPct),
    };
  }

  // --- Caja del mes ---------------------------------------------------------------

  /** Lo cobrado este mes y lo que queda por cobrar, frente al objetivo mensual. */
  async cashMonth(now = new Date()): Promise<AdminCashMonthDto> {
    const idx = madridMonthIndex(now);
    const start = monthIndexStart(idx);
    const end = monthIndexStart(idx + 1);
    const [payments, expected, goals] = await Promise.all([
      this.admin.tenantSubscriptionPayment.findMany({
        where: {
          status: { in: [...COLLECTED_PAYMENT_STATUSES] },
          paidAt: { gte: start, lt: end },
          tenant: { billingExempt: false },
        },
        select: { amount: true, refundedAmount: true },
      }),
      this.billingOps.expectedBetween(now, new Date(end.getTime() - 1)),
      this.admin.platformBusinessGoals.findFirst({ select: { collectedTargetMonthly: true } }),
    ]);
    const collected = round2(payments.reduce((s, p) => s + netPaid(p), 0));
    const projected = round2(collected + expected.total);
    const target =
      goals?.collectedTargetMonthly != null ? Number(goals.collectedTargetMonthly) : null;
    const pctOf = (n: number) => (target && target > 0 ? round2((n / target) * 100) : null);
    return {
      label: `${MONTHS_LONG_ES[idx % 12]} de ${Math.floor(idx / 12)}`,
      collected,
      expectedRest: expected.total,
      overdue: expected.overdue,
      projected,
      target,
      collectedPct: pctOf(collected),
      projectedPct: pctOf(projected),
    };
  }

  // --- Exportar -------------------------------------------------------------------

  async csv(
    kind: string,
    opts: { months: number; vatIncluded: boolean; year: number },
  ): Promise<{ filename: string; body: string }> {
    if (!(FINANCE_CSV_KINDS as readonly string[]).includes(kind)) {
      throw new BadRequestException({ code: 'invalid_export', message: 'Exportación desconocida' });
    }
    const k = kind as AdminFinanceCsvKind;
    const vatLabel = opts.vatIncluded ? 'con IVA' : 'sin IVA';
    if (k === 'vat') {
      const vat = await this.vatQuarterly(opts.year);
      const rows: (string | number | null)[][] = [
        ['Trimestre', 'Tipo de IVA (%)', 'Facturas', 'Base imponible', 'Cuota de IVA', 'Total'],
      ];
      for (const q of vat.quarters) {
        if (q.byRate.length === 0) rows.push([q.label, null, 0, 0, 0, 0]);
        for (const r of q.byRate) {
          rows.push([q.label, r.rate, q.invoices, r.base, r.tax, r.total]);
        }
      }
      rows.push([
        `Total ${vat.year}`,
        null,
        vat.totals.invoices,
        vat.totals.base,
        vat.totals.tax,
        vat.totals.total,
      ]);
      return { filename: `iva-trimestral-${vat.year}.csv`, body: toCsv(rows) };
    }
    if (k === 'margin') {
      const m = await this.margin(opts.months);
      const rows: (string | number | null)[][] = [
        [
          'Mes',
          'Ingresos netos sin IVA',
          'Comisiones de pasarela',
          'IA',
          'Correo',
          'Comisiones de comerciales',
          'Margen',
          'Margen (%)',
        ],
        ...m.monthly.map((r) => [
          r.label,
          r.revenue,
          r.gatewayFees,
          r.aiCost,
          r.emailCost,
          r.salesCommissions,
          r.margin,
          r.marginPct,
        ]),
        [
          'Total',
          m.totals.revenue,
          m.totals.gatewayFees,
          m.totals.aiCost,
          m.totals.emailCost,
          m.totals.salesCommissions,
          m.totals.margin,
          m.totals.marginPct,
        ],
      ];
      return { filename: `margen-${opts.months}m.csv`, body: toCsv(rows) };
    }
    const overview = await this.finance.getOverview(opts.months, opts.vatIncluded);
    if (k === 'monthly') {
      const rows: (string | number | null)[][] = [
        [
          'Mes',
          `Stripe (${vatLabel})`,
          `Remesa SEPA (${vatLabel})`,
          `Redsys (${vatLabel})`,
          `A mano (${vatLabel})`,
          `Total neto (${vatLabel})`,
          `Devuelto (${vatLabel})`,
        ],
        ...overview.monthly.map((m) => [
          m.month,
          m.stripe,
          m.sepa,
          m.redsys,
          m.manual,
          m.total,
          m.refunded,
        ]),
      ];
      return { filename: `finanzas-mensual-${opts.months}m.csv`, body: toCsv(rows) };
    }
    if (k === 'providers') {
      const rows: (string | number | null)[][] = [
        ['Método', 'Nº de cobros', `Total (${vatLabel})`],
        ...overview.byProvider.map((p) => [
          PROVIDER_LABELS[p.provider] ?? p.provider,
          p.count,
          p.total,
        ]),
      ];
      return { filename: `finanzas-por-metodo-${opts.months}m.csv`, body: toCsv(rows) };
    }
    // Conciliación.
    const rec = overview.reconciliation;
    const day = (iso: string) => iso.slice(0, 10);
    const rows: (string | number | null)[][] = [
      ['Tipo', 'Fecha', 'Tenant', 'Referencia', 'Importe (con IVA)'],
      ...rec.payments.map((p) => [
        'Cobro sin factura',
        day(p.paidAt),
        p.tenantName,
        PROVIDER_LABELS[p.provider] ?? p.provider,
        p.amount,
      ]),
      ...rec.invoices.map((i) => [
        'Factura sin cobro',
        day(i.issuedAt),
        i.tenantName,
        i.fullNumber,
        i.total,
      ]),
    ];
    return { filename: `conciliacion-${opts.months}m.csv`, body: toCsv(rows) };
  }

  /** Informe de Finanzas en PDF (periodo, IVA, margen y conciliación). */
  async pdf(months: number, vatIncluded: boolean): Promise<Buffer> {
    return this.printPdf(await this.pdfHtml(months, vatIncluded));
  }

  /** La página del informe de Finanzas (lo que se imprime en el PDF). */
  async pdfHtml(months: number, vatIncluded: boolean): Promise<string> {
    const year = Math.floor(madridMonthIndex(new Date()) / 12);
    const [o, m, vat] = await Promise.all([
      this.finance.getOverview(months, vatIncluded),
      this.margin(months),
      this.vatQuarterly(year),
    ]);
    const vatLabel = vatIncluded ? 'con IVA' : 'sin IVA';
    const table = (head: string[], rows: string[][]) =>
      `<table><thead><tr>${head.map((h, i) => `<th${i > 0 ? ' class="n"' : ''}>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows
        .map(
          (r) =>
            `<tr>${r.map((c, i) => `<td${i > 0 ? ' class="n"' : ''}>${escapeHtml(c)}</td>`).join('')}</tr>`,
        )
        .join('')}</tbody></table>`;
    const kpis: [string, string][] = [
      [`Cobrado neto (${vatLabel})`, eur(o.collectedTotal)],
      [`Devuelto (${vatLabel})`, eur(o.refundedTotal)],
      [`Facturado neto (${vatLabel})`, eur(o.invoicedTotal)],
      ['MRR de los extras (sin IVA)', eur(o.addonsMrr)],
      ['Margen del periodo (sin IVA)', eur(m.totals.margin)],
      ['Margen (%)', pctText(m.totals.marginPct)],
    ];
    const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
body{font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#111;font-size:11px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:13px;margin:20px 0 6px}
p.sub{color:#666;margin:0 0 14px}table{border-collapse:collapse;width:100%}
th{text-align:left;color:#666;font-weight:500;border-bottom:1px solid #ddd;padding:4px 6px}
td{padding:4px 6px;border-bottom:1px solid #eee}.n{text-align:right;font-variant-numeric:tabular-nums}
</style></head><body>
<h1>Finanzas · últimos ${months} meses</h1>
<p class="sub">TrasterOS · plataforma · importes ${escapeHtml(vatLabel)} salvo que se indique</p>
${table(['Concepto', 'Valor'], kpis)}
<h2>Por mes y forma de cobro (${escapeHtml(vatLabel)})</h2>
${table(
  ['Mes', 'Stripe', 'SEPA', 'Redsys', 'A mano', 'Total', 'Devuelto'],
  o.monthly.map((r) => [
    r.month,
    eur(r.stripe),
    eur(r.sepa),
    eur(r.redsys),
    eur(r.manual),
    eur(r.total),
    eur(r.refunded),
  ]),
)}
<h2>Margen (sin IVA)</h2>
${table(
  ['Mes', 'Ingresos', 'Pasarelas', 'IA', 'Correo', 'Comerciales', 'Margen'],
  m.monthly.map((r) => [
    r.label,
    eur(r.revenue),
    eur(r.gatewayFees),
    eur(r.aiCost),
    eur(r.emailCost),
    eur(r.salesCommissions),
    eur(r.margin),
  ]),
)}
<h2>IVA repercutido ${vat.year}</h2>
${table(
  ['Trimestre', 'Facturas', 'Base', 'Cuota', 'Total'],
  vat.quarters.map((q) => [q.label, String(q.invoices), eur(q.base), eur(q.tax), eur(q.total)]),
)}
<h2>Conciliación</h2>
<p>${o.reconciliation.paymentsWithoutInvoice.count} cobros sin factura (${escapeHtml(eur(o.reconciliation.paymentsWithoutInvoice.total))}) · ${o.reconciliation.invoicesWithoutPayment.count} facturas sin cobro (${escapeHtml(eur(o.reconciliation.invoicesWithoutPayment.total))}).</p>
</body></html>`;
    return html;
  }

  /** Imprime la página con el navegador sin cabeza (Puppeteer). */
  async printPdf(html: string): Promise<Buffer> {
    const puppeteer = await loadPuppeteer();
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      const pdf = await page.pdf({
        format: 'A4',
        margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
      });
      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }
}
