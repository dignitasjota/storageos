import { zonedMonthStart } from '../format';
import {
  churnedBetween,
  isPayingSubscription,
  madridMonthIndex,
  monthIndexDate,
  monthIndexLabel,
  monthIndexStart,
  parseMonthsParam,
  payingAt,
  sameInstantLastYear,
  subscriptionCycle,
  tenantMetricsState,
  tenantMrr,
  tenantMrrDetail,
  trialOutcome,
  type PayerLifecycle,
} from '../saas-metrics';

const DAY = 86_400_000;
const withVat = { includeVat: true, taxRate: 21 };
const plusVat = { includeVat: false, taxRate: 21 };

function sub(days: number, billingMode = 'manual') {
  const start = new Date('2026-01-01T00:00:00Z');
  return {
    billingMode,
    currentPeriodStart: start,
    currentPeriodEnd: new Date(start.getTime() + days * DAY),
    plan: { priceMonthly: 121, priceYearly: 1210 },
  };
}

describe('saas-metrics', () => {
  it('MRR: mensual o anual entre 12, sin IVA, con descuento y extras', () => {
    expect(tenantMrr(sub(30), { addonsMonthly: 0, discountRatio: 0, pricing: withVat })).toEqual({
      plan: 100,
      addons: 0,
      total: 100,
    });
    // Anual: 1210 / 12 sin IVA.
    expect(
      tenantMrr(sub(365), { addonsMonthly: 0, discountRatio: 0, pricing: withVat }).plan,
    ).toBeCloseTo(83.33, 2);
    // Con SEPA siempre es la cuota mensual.
    expect(subscriptionCycle(sub(365, 'sepa'))).toBe('monthly');
    // Descuento del 10 % y un extra de 24,20 € (con IVA).
    expect(
      tenantMrr(sub(30), { addonsMonthly: 24.2, discountRatio: 0.1, pricing: withVat }),
    ).toEqual({ plan: 90, addons: 20, total: 110 });
    // Precios +IVA: el de lista ya es sin IVA.
    expect(tenantMrr(sub(30), { addonsMonthly: 0, discountRatio: 0, pricing: plusVat }).total).toBe(
      121,
    );
  });

  it('quién paga y en qué estado está', () => {
    expect(isPayingSubscription({ status: 'past_due' }, { status: 'active' })).toBe(true);
    expect(isPayingSubscription({ status: 'active' }, { status: 'trial' })).toBe(false);
    expect(isPayingSubscription({ status: 'active' }, { status: 'suspended' })).toBe(false);
    expect(
      isPayingSubscription({ status: 'active' }, { status: 'active', billingExempt: true }),
    ).toBe(false);
    expect(tenantMetricsState('active', 'expired')).toBe('read_only');
    expect(tenantMetricsState('active', 'past_due')).toBe('past_due');
    expect(tenantMetricsState('active', 'active')).toBe('active');
    expect(tenantMetricsState('trial', 'trial')).toBe('trial');
  });

  it('meses en hora de España', () => {
    // 31 dic a las 23:30 UTC ya es 1 de enero en Madrid.
    const idx = madridMonthIndex(new Date('2025-12-31T23:30:00Z'));
    expect(monthIndexLabel(idx)).toBe('ene 26');
    expect(monthIndexDate(idx).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(monthIndexStart(idx).toISOString()).toBe('2025-12-31T23:00:00.000Z');
    // En verano, Madrid va dos horas por delante.
    expect(zonedMonthStart(2026, 7).toISOString()).toBe('2026-06-30T22:00:00.000Z');
  });

  it('months de la URL: número o valor por defecto', () => {
    expect(parseMonthsParam('abc')).toBe(12);
    expect(parseMonthsParam(undefined, 6)).toBe(6);
    expect(parseMonthsParam('3')).toBe(3);
    expect(parseMonthsParam('99')).toBe(24);
    expect(parseMonthsParam('0')).toBe(1);
  });

  it('bajas y pruebas: solo cuenta quien llegó a pagar', () => {
    const payer: PayerLifecycle = {
      tenantId: 't',
      name: 'T',
      slug: 't',
      createdAt: new Date('2026-01-01'),
      firstPaidAt: new Date('2026-01-15'),
      churnedAt: new Date('2026-03-10'),
      churnReason: null,
      status: 'suspended',
      subscription: null,
      lastMrr: 50,
    };
    expect(churnedBetween(payer, new Date('2026-03-01'), new Date('2026-04-01'))).toBe(true);
    expect(payingAt(payer, new Date('2026-02-01'))).toBe(true);
    expect(payingAt(payer, new Date('2026-01-10'))).toBe(false);
    expect(trialOutcome({ status: 'suspended' }, payer)).toBe('churned');
    expect(trialOutcome({ status: 'active' }, { ...payer, churnedAt: null })).toBe('converted');
    expect(trialOutcome({ status: 'active' }, undefined)).toBe('toFree');
    expect(trialOutcome({ status: 'trial' }, undefined)).toBe('inTrial');
  });

  it('desglose: descuento que se deja de ingresar y ciclo', () => {
    const monthly = tenantMrrDetail(sub(30), {
      addonsMonthly: 0,
      discountRatio: 0.1,
      pricing: withVat,
    });
    expect(monthly).toEqual({ plan: 90, addons: 0, total: 90, discount: 10, cycle: 'monthly' });
    const yearly = tenantMrrDetail(sub(365), {
      addonsMonthly: 0,
      discountRatio: 0.5,
      pricing: withVat,
    });
    expect(yearly.cycle).toBe('yearly');
    expect(yearly.discount).toBeCloseTo(41.67, 2);
  });

  it('el mismo momento del año pasado, sin pasar del fin de mes', () => {
    const now = new Date('2026-11-22T10:00:00Z');
    expect(sameInstantLastYear(now).toISOString()).toBe('2025-11-22T10:00:00.000Z');
    // 29 de febrero → como mucho el 1 de marzo del año anterior (fin del mes).
    const leap = new Date('2028-02-29T12:00:00Z');
    expect(sameInstantLastYear(leap).getTime()).toBeLessThanOrEqual(
      new Date('2027-03-01T00:00:00+01:00').getTime(),
    );
  });
});
