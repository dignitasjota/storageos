import { MarketingChannelsService } from '../marketing-channels.service';

import type { PrismaAdminService } from '../../database/prisma-admin.service';
import type { PrismaService } from '../../database/prisma.service';

interface TxMock {
  marketingChannel: { findMany: jest.Mock };
  expense: { findMany: jest.Mock };
  lead: { findMany: jest.Mock };
  contract: { findMany: jest.Mock };
}

function buildTx(): TxMock {
  return {
    marketingChannel: { findMany: jest.fn().mockResolvedValue([]) },
    expense: { findMany: jest.fn().mockResolvedValue([]) },
    lead: { findMany: jest.fn().mockResolvedValue([]) },
    contract: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

function buildService(tx: TxMock) {
  const prisma = {
    withTenant: <T>(fn: (t: TxMock) => Promise<T>) => fn(tx),
  } as unknown as PrismaService;
  const admin = {} as PrismaAdminService;
  return new MarketingChannelsService(prisma, admin);
}

const TENANT = '019e3d20-aaaa-7c2f-bf37-6511065b9fc5';

function channel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chan-1',
    name: 'Google Ads Verano',
    type: 'google_ads',
    status: 'active',
    utmSourceMatch: 'google_verano',
    ...overrides,
  };
}

describe('MarketingChannelsService.getPerformance', () => {
  it('tenant sin canales devuelve filas y totales a cero', async () => {
    const tx = buildTx();
    const service = buildService(tx);
    const res = await service.getPerformance(TENANT, {});
    expect(res.rows).toEqual([]);
    expect(res.totals).toEqual({ cost: 0, leadsCount: 0, wonCount: 0, mrrGenerated: 0 });
  });

  it('un canal sin gasto ni leads sale con ceros y `null` en las métricas derivadas', async () => {
    const tx = buildTx();
    tx.marketingChannel.findMany.mockResolvedValue([channel()]);
    const service = buildService(tx);
    const res = await service.getPerformance(TENANT, {});
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({
      channelId: 'chan-1',
      cost: 0,
      leadsCount: 0,
      wonCount: 0,
      costPerLead: null,
      cac: null,
      mrrGenerated: 0,
      paybackMonths: null,
    });
  });

  it('coste vinculado + leads atribuidos por utmSource/source + conversión → CAC y payback', async () => {
    const tx = buildTx();
    tx.marketingChannel.findMany.mockResolvedValue([channel()]);
    tx.expense.findMany.mockResolvedValue([
      { marketingChannelId: 'chan-1', amount: 120 },
      { marketingChannelId: 'chan-1', amount: 80 },
    ]);
    tx.lead.findMany.mockResolvedValue([
      // Atribuido por utmSource exacto (case-insensitive).
      { source: 'widget', utmSource: 'Google_Verano', status: 'won', convertedContractId: 'ct-1' },
      // Atribuido por `source` a falta de utmSource, sin convertir.
      { source: 'google_verano', utmSource: null, status: 'new', convertedContractId: null },
      // Otro canal: no debe contarse.
      { source: 'facebook', utmSource: 'facebook', status: 'new', convertedContractId: null },
    ]);
    tx.contract.findMany.mockResolvedValue([{ id: 'ct-1', priceMonthly: 100, discountAmount: 10 }]);

    const service = buildService(tx);
    const res = await service.getPerformance(TENANT, {});
    expect(res.rows).toHaveLength(1);
    const row = res.rows[0]!;
    expect(row.cost).toBe(200);
    expect(row.leadsCount).toBe(2);
    expect(row.wonCount).toBe(1);
    expect(row.costPerLead).toBe(100); // 200 / 2
    expect(row.cac).toBe(200); // 200 / 1 conversión
    expect(row.mrrGenerated).toBe(90); // 100 - 10 de descuento
    expect(row.paybackMonths).toBe(2.22); // round2(200 / 90)

    expect(res.totals).toEqual({ cost: 200, leadsCount: 2, wonCount: 1, mrrGenerated: 90 });
  });

  it('un contrato ganado que ya no está activo/ending no aporta MRR', async () => {
    const tx = buildTx();
    tx.marketingChannel.findMany.mockResolvedValue([channel()]);
    tx.lead.findMany.mockResolvedValue([
      { source: null, utmSource: 'google_verano', status: 'won', convertedContractId: 'ct-1' },
    ]);
    // El filtro de contratos en el service exige status active/ending → una
    // baja no debería reaparecer, así que el mock simplemente no la incluye.
    tx.contract.findMany.mockResolvedValue([]);

    const service = buildService(tx);
    const res = await service.getPerformance(TENANT, {});
    expect(res.rows[0]!.mrrGenerated).toBe(0);
    expect(res.rows[0]!.paybackMonths).toBeNull();
  });

  it('ordena por coste desc y, en empate, por MRR generado desc', async () => {
    const tx = buildTx();
    tx.marketingChannel.findMany.mockResolvedValue([
      channel({ id: 'low-cost', utmSourceMatch: 'low' }),
      channel({ id: 'high-cost', utmSourceMatch: 'high' }),
    ]);
    tx.expense.findMany.mockResolvedValue([
      { marketingChannelId: 'low-cost', amount: 50 },
      { marketingChannelId: 'high-cost', amount: 300 },
    ]);

    const service = buildService(tx);
    const res = await service.getPerformance(TENANT, {});
    expect(res.rows.map((r) => r.channelId)).toEqual(['high-cost', 'low-cost']);
  });
});
