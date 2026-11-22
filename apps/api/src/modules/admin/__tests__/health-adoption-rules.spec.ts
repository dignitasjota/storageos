import { adoptionLimits, pickRecommendedPlan } from '../adoption-rules';
import { scoreHealth, type HealthSignalsInput } from '../tenant-health-score';
import { contractBillingOnTime } from '../tenant-health.service';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 22, 12);

function input(over: Partial<HealthSignalsInput> = {}): HealthSignalsInput {
  return {
    id: 't1',
    name: 'Trasteros',
    slug: 'trasteros',
    status: 'active',
    billingExempt: false,
    planName: 'Starter',
    subStatus: 'active',
    cancelAtPeriodEnd: false,
    trialEndsAt: null,
    paying: true,
    lastActivityAt: new Date(NOW - DAY),
    billingExpected: 0,
    billingOnTime: 0,
    activeContracts: 0,
    facilities: 1,
    units: 0,
    customers: 0,
    customersTotal: 0,
    portalUsers: 0,
    portalEverUsed: 0,
    staleTickets: 0,
    signedContracts: 0,
    issuedInvoices: 0,
    previousScore: null,
    ...over,
  };
}

const factor = (h: ReturnType<typeof scoreHealth>, key: string) =>
  h.factors.find((f) => f.key === key)!;

describe('salud de un cliente', () => {
  it('lo que no aplica no cuenta y su peso se reparte', () => {
    const h = scoreHealth(input(), NOW);
    expect(h.segment).toBe('paying');
    expect(factor(h, 'billing').counted).toBe(false);
    expect(factor(h, 'portal').counted).toBe(false);
    // Actividad 100 (0,3), suscripción 100 (0,2), adopción 15 (0,15), soporte 100 (0,05).
    expect(h.score).toBe(Math.round((30 + 20 + 15 * 0.15 + 5) / 0.7));
  });

  it('suscripción cancelada o atrasada puntúa bajo', () => {
    expect(
      factor(scoreHealth(input({ subStatus: 'cancelled', paying: false }), NOW), 'subscription')
        .score,
    ).toBe(10);
    expect(factor(scoreHealth(input({ subStatus: 'past_due' }), NOW), 'subscription').score).toBe(
      10,
    );
    expect(
      factor(scoreHealth(input({ subStatus: 'expired', paying: false }), NOW), 'subscription')
        .score,
    ).toBe(10);
  });

  it('las exentas no cuentan la suscripción y las pruebas llevan activación', () => {
    const exempt = scoreHealth(input({ billingExempt: true }), NOW);
    expect(exempt.segment).toBe('exempt');
    expect(factor(exempt, 'subscription').counted).toBe(false);
    const trial = scoreHealth(
      input({ status: 'trial', paying: false, facilities: 1, units: 6 }),
      NOW,
    );
    expect(trial.kind).toBe('activation');
    expect(factor(trial, 'units').score).toBe(100);
    expect(factor(trial, 'contract').score).toBe(0);
  });
});

describe('facturación al día', () => {
  it('un prepago con su periodo vigente está al día', () => {
    expect(
      contractBillingOnTime(
        {
          intervalMonths: 12,
          lastIssueDate: new Date(NOW - 200 * DAY),
          lastPeriodEnd: new Date(NOW + 100 * DAY),
        },
        NOW,
      ),
    ).toBe(true);
  });
  it('un mensual sin factura en 35 días va atrasado', () => {
    expect(
      contractBillingOnTime(
        {
          intervalMonths: 1,
          lastIssueDate: new Date(NOW - 40 * DAY),
          lastPeriodEnd: new Date(NOW - 10 * DAY),
        },
        NOW,
      ),
    ).toBe(false);
  });
});

describe('límites y plan recomendado', () => {
  it('un local en un plan de un local no topa; los trasteros sí', () => {
    const r = adoptionLimits(
      { units: 10, facilities: 1, users: 1 },
      { units: 10, facilities: 1, users: 1 },
      { inTrial: true, realUse: false },
    );
    expect(r.tapsLimit).toBe(true);
    expect(r.atLimit).toEqual({ units: true, facilities: false, users: false });
    expect(r.detail).toBe('10 de 10 trasteros (100 %)');
  });

  it('cerca del límite al 80 % sin topar', () => {
    const r = adoptionLimits(
      { units: 8, facilities: 1, users: 1 },
      { units: 10, facilities: 3, users: 10 },
      { inTrial: false, realUse: true },
    );
    expect(r).toMatchObject({ tapsLimit: false, nearLimit: true });
  });

  it('recomienda el plan con margen', () => {
    const plans = [
      {
        id: 'a',
        slug: 'free',
        priceMonthly: 0,
        maxUnits: 10,
        maxFacilities: 1,
        maxUsers: 2,
        tenantFeatures: [],
      },
      {
        id: 'b',
        slug: 'starter',
        priceMonthly: 79,
        maxUnits: 200,
        maxFacilities: 3,
        maxUsers: 10,
        tenantFeatures: [],
      },
    ];
    const pick = (units: number) =>
      pickRecommendedPlan(plans, {
        used: new Set(),
        sellableInPlans: new Set(),
        usage: { units, facilities: 1, users: 1 },
        extra: { units: 0, facilities: 0, users: 0 },
        needsRoom: { units: false, facilities: false, users: false },
      })?.slug;
    expect(pick(8)).toBe('free');
    expect(pick(9)).toBe('starter');
  });
});

describe('mejoras de salud', () => {
  it('la frecuencia solo cuenta con un mes de registro y hace media con lo reciente', () => {
    const fresh = scoreHealth(input({ activeDays30: 1, activityTracked: false }), NOW);
    expect(factor(fresh, 'engagement').score).toBe(100);
    const tracked = scoreHealth(input({ activeDays30: 1, activityTracked: true }), NOW);
    expect(factor(tracked, 'engagement').score).toBe(63);
    const daily = scoreHealth(input({ activeDays30: 14, activityTracked: true }), NOW);
    expect(factor(daily, 'engagement').score).toBe(100);
  });

  it('los pesos se pueden cambiar', () => {
    const h = scoreHealth(input({ lastActivityAt: null }), NOW, {
      client: { engagement: 100, billing: 0, subscription: 0, adoption: 0, portal: 0, support: 0 },
      trial: { facility: 15, units: 15, customer: 15, contract: 25, invoice: 15, team: 15 },
    });
    expect(h.score).toBe(0);
    expect(h.mainDrag?.key).toBe('engagement');
    expect(h.mainDrag?.action.label).toBe('Escribir');
  });

  it('riesgo en clientes y probabilidad de pagar en pruebas', () => {
    const client = scoreHealth(input({ lastActivityAt: null }), NOW);
    expect(client.churnRisk).not.toBeNull();
    expect(client.payProbability).toBeNull();
    const trial = scoreHealth(
      input({ status: 'trial', trialEndsAt: new Date(NOW + 2 * DAY), facilities: 0 }),
      NOW,
    );
    expect(trial.churnRisk).toBeNull();
    expect(trial.trialDaysLeft).toBe(2);
    expect(trial.payProbability).toEqual(expect.any(Number));
  });
});
