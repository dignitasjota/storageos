import { InsightsService } from '../insights.service';

import type { PrismaService } from '../../database/prisma.service';

const TENANT = '019e3d20-aaaa-7c2f-bf37-6511065b9fc5';
const CUSTOMER_ID = '019e3d20-cccc-7c2f-bf37-6511065b9fc5';

interface TxMock {
  contract: { findMany: jest.Mock };
  invoice: { groupBy: jest.Mock };
  payment: { groupBy: jest.Mock };
  dunningAction: { findMany: jest.Mock };
  paymentMethod: { findMany: jest.Mock };
  unitType: { findMany: jest.Mock };
  unit: { groupBy: jest.Mock };
}

function buildTx(): TxMock {
  return {
    contract: { findMany: jest.fn().mockResolvedValue([]) },
    invoice: { groupBy: jest.fn().mockResolvedValue([]) },
    payment: { groupBy: jest.fn().mockResolvedValue([]) },
    dunningAction: { findMany: jest.fn().mockResolvedValue([]) },
    paymentMethod: { findMany: jest.fn().mockResolvedValue([]) },
    unitType: { findMany: jest.fn().mockResolvedValue([]) },
    unit: { groupBy: jest.fn().mockResolvedValue([]) },
  };
}

function buildService(tx: TxMock) {
  const prisma = {
    withTenant: <T>(fn: (t: TxMock) => Promise<T>) => fn(tx),
  } as unknown as PrismaService;
  return new InsightsService(prisma);
}

function activeContract(overrides: Record<string, unknown> = {}) {
  return {
    id: 'contract-1',
    contractNumber: 'CT-2026-00001',
    customerId: CUSTOMER_ID,
    priceMonthly: 100,
    endDate: null,
    autoRenew: true,
    customer: {
      id: CUSTOMER_ID,
      customerType: 'individual',
      firstName: 'Ana',
      lastName: 'García',
      companyName: null,
    },
    unit: { code: 'A-101', facility: { name: 'Local Centro' } },
    ...overrides,
  };
}

describe('InsightsService.getChurnRisk', () => {
  it('tenant sin contratos devuelve summary a cero', async () => {
    const tx = buildTx();
    const service = buildService(tx);
    const res = await service.getChurnRisk(TENANT);
    expect(res.summary).toEqual({ high: 0, medium: 0, low: 0, total: 0 });
    expect(res.items).toEqual([]);
  });

  it('acumula señales hasta riesgo alto y lo ordena en el detalle', async () => {
    const tx = buildTx();
    tx.contract.findMany.mockResolvedValue([activeContract()]);
    // 2 facturas vencidas, deuda > 1 mensualidad → 35 + 10 + 10 = 55
    tx.invoice.groupBy.mockResolvedValue([
      { customerId: CUSTOMER_ID, _count: { _all: 2 }, _sum: { total: 250, amountPaid: 0 } },
    ]);
    // 1 cobro fallido → +20
    tx.payment.groupBy.mockResolvedValue([{ customerId: CUSTOMER_ID, _count: { _all: 1 } }]);
    // sin método de pago default → +15  ⇒ total 90 (capado a 100)
    tx.paymentMethod.findMany.mockResolvedValue([]);

    const service = buildService(tx);
    const res = await service.getChurnRisk(TENANT);

    expect(res.summary.total).toBe(1);
    expect(res.summary.high).toBe(1);
    expect(res.items).toHaveLength(1);
    const item = res.items[0]!;
    expect(item.level).toBe('high');
    expect(item.score).toBe(90);
    expect(item.factors).toEqual(
      expect.arrayContaining([
        '2 facturas vencidas',
        'debe más de una mensualidad',
        '1 cobro fallido',
        'sin método de pago guardado',
      ]),
    );
  });

  it('cliente al día con método de pago no aparece en el detalle (low)', async () => {
    const tx = buildTx();
    tx.contract.findMany.mockResolvedValue([activeContract()]);
    tx.paymentMethod.findMany.mockResolvedValue([{ customerId: CUSTOMER_ID }]);

    const service = buildService(tx);
    const res = await service.getChurnRisk(TENANT);
    expect(res.summary).toEqual({ high: 0, medium: 0, low: 1, total: 1 });
    expect(res.items).toEqual([]);
  });
});

describe('InsightsService.getPricingSuggestions', () => {
  it('mapea ocupación a acción y precio sugerido', async () => {
    const tx = buildTx();
    tx.unitType.findMany.mockResolvedValue([
      { id: 'ut-high', name: 'Pequeño', defaultPriceMonthly: 50 },
      { id: 'ut-low', name: 'Grande', defaultPriceMonthly: 100 },
      { id: 'ut-empty', name: 'Vacío', defaultPriceMonthly: 30 },
    ]);
    tx.unit.groupBy.mockImplementation(({ where }: { where?: { status?: string } }) => {
      if (where?.status === 'occupied') {
        return Promise.resolve([
          { unitTypeId: 'ut-high', _count: { _all: 10 } }, // 100%
          { unitTypeId: 'ut-low', _count: { _all: 3 } }, // 30%
        ]);
      }
      return Promise.resolve([
        { unitTypeId: 'ut-high', _count: { _all: 10 } },
        { unitTypeId: 'ut-low', _count: { _all: 10 } },
        // ut-empty: 0 units → se omite
      ]);
    });

    const service = buildService(tx);
    const res = await service.getPricingSuggestions(TENANT);

    expect(res.items).toHaveLength(2);
    const high = res.items.find((i) => i.unitTypeId === 'ut-high')!;
    expect(high.occupancy).toBe(100);
    expect(high.action).toBe('raise');
    expect(high.changePct).toBe(10);
    expect(high.suggestedPrice).toBe(55);

    const low = res.items.find((i) => i.unitTypeId === 'ut-low')!;
    expect(low.occupancy).toBe(30);
    expect(low.action).toBe('lower');
    expect(low.changePct).toBe(-10);
    expect(low.suggestedPrice).toBe(90);

    // El primero ordenado es el de mayor ocupación.
    expect(res.items[0]!.unitTypeId).toBe('ut-high');
  });
});
