import { MarketingChannelsService } from '../marketing-channels.service';

import type { PrismaAdminService } from '../../database/prisma-admin.service';
import type { PrismaService } from '../../database/prisma.service';
import type { MarketingViewer } from '../marketing-viewer';
import type { Queue } from 'bullmq';

interface TxMock {
  tenant: { findUnique: jest.Mock };
  marketingChannel: { findMany: jest.Mock };
  expense: { groupBy: jest.Mock; aggregate: jest.Mock };
  lead: { findMany: jest.Mock };
  contract: { findMany: jest.Mock };
  couponRedemption: { findMany: jest.Mock };
  $queryRaw: jest.Mock;
}

function buildTx(): TxMock {
  return {
    tenant: { findUnique: jest.fn().mockResolvedValue({ timezone: 'Europe/Madrid' }) },
    marketingChannel: { findMany: jest.fn().mockResolvedValue([]) },
    expense: {
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }),
    },
    lead: { findMany: jest.fn().mockResolvedValue([]) },
    contract: { findMany: jest.fn().mockResolvedValue([]) },
    couponRedemption: { findMany: jest.fn().mockResolvedValue([]) },
    // Visitas ya sumadas y cobros: vacío salvo que la prueba diga otra cosa.
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
}

function buildService(tx: TxMock) {
  const prisma = {
    withTenant: <T>(fn: (t: TxMock) => Promise<T>) => fn(tx),
  } as unknown as PrismaService;
  const admin = {} as PrismaAdminService;
  return new MarketingChannelsService(prisma, admin, {} as Queue);
}

const TENANT = '019e3d20-aaaa-7c2f-bf37-6511065b9fc5';

function channel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chan-1',
    name: 'Google Ads Verano',
    type: 'google_ads',
    status: 'active',
    utmSourceMatch: 'google_verano',
    externalCampaignId: null,
    externalUrl: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
    promotionId: null,
    couponId: null,
    ...overrides,
  };
}

const lead = (over: Record<string, unknown>) => ({
  source: 'web',
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  marketingChannelId: null,
  metadata: {},
  ...over,
});

const contract = (over: Record<string, unknown>) => ({
  id: 'ct-1',
  status: 'active',
  promotionId: null,
  priceMonthly: 100,
  discountAmount: 0,
  ...over,
});

describe('MarketingChannelsService.getPerformance', () => {
  it('tenant sin canales devuelve filas y totales a cero', async () => {
    const tx = buildTx();
    const res = await buildService(tx).getPerformance(TENANT, {});
    expect(res.rows).toEqual([]);
    expect(res.totals).toEqual({ cost: 0, leadsCount: 0, wonCount: 0, mrrGenerated: 0 });
    expect(res.unassignedCost).toBe(0);
    expect(res.money).toEqual({ revenue: true, cost: true });
  });

  it('un canal sin gasto ni contactos sale con ceros y `null` en las métricas derivadas', async () => {
    const tx = buildTx();
    tx.marketingChannel.findMany.mockResolvedValue([channel()]);
    const res = await buildService(tx).getPerformance(TENANT, {});
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({
      channelId: 'chan-1',
      deleted: false,
      cost: 0,
      leadsCount: 0,
      wonCount: 0,
      costPerLead: null,
      cac: null,
      mrrGenerated: 0,
      liveCount: 0,
      paybackMonths: null,
    });
  });

  it('coste vinculado + contactos por origen + cliente firmado → coste por cliente y payback', async () => {
    const tx = buildTx();
    tx.marketingChannel.findMany.mockResolvedValue([
      channel({ name: 'Flyers verano', type: 'physical' }),
    ]);
    tx.expense.groupBy.mockResolvedValue([{ marketingChannelId: 'chan-1', _sum: { amount: 200 } }]);
    tx.expense.aggregate.mockResolvedValue({ _sum: { amount: 35 } });
    tx.contract.findMany.mockResolvedValue([contract({ discountAmount: 10 })]);
    tx.lead.findMany
      // Contactos creados en el periodo.
      .mockResolvedValueOnce([
        lead({ source: 'widget', utmSource: 'Google_Verano' }),
        lead({ source: 'google_verano' }),
        lead({ source: 'facebook', utmSource: 'facebook' }),
      ])
      // Reservas online del periodo.
      .mockResolvedValueOnce([])
      // Contactos de los contratos firmados en el periodo.
      .mockResolvedValueOnce([
        lead({ convertedContractId: 'ct-1', source: 'widget', utmSource: 'google_verano' }),
      ]);

    const res = await buildService(tx).getPerformance(TENANT, {});
    const row = res.rows[0]!;
    expect(row.cost).toBe(200);
    expect(row.leadsCount).toBe(2);
    expect(row.wonCount).toBe(1);
    expect(row.costPerLead).toBe(100);
    expect(row.cac).toBe(200);
    expect(row.mrrGenerated).toBe(90);
    expect(row.liveCount).toBe(1);
    expect(row.paybackMonths).toBe(2.22);
    expect(res.totals).toEqual({ cost: 200, leadsCount: 2, wonCount: 1, mrrGenerated: 90 });
    // El gasto de marketing sin canal sale aparte.
    expect(res.unassignedCost).toBe(35);
  });

  it('Google Ads solo cuenta el tráfico de pago y cada contacto va a un solo canal', async () => {
    const tx = buildTx();
    tx.marketingChannel.findMany.mockResolvedValue([
      channel({ id: 'ads', name: 'Google Ads', utmSourceMatch: 'google_ads_norte' }),
      channel({
        id: 'seo',
        name: 'Google orgánico',
        type: 'other',
        utmSourceMatch: 'google',
        createdAt: new Date('2026-02-01T00:00:00Z'),
      }),
      channel({
        id: 'seo-2',
        name: 'SEO duplicado',
        type: 'other',
        utmSourceMatch: 'google',
        createdAt: new Date('2026-03-01T00:00:00Z'),
      }),
    ]);
    tx.lead.findMany.mockResolvedValueOnce([
      lead({ utmSource: 'google', utmMedium: 'cpc' }),
      lead({ utmSource: 'google', utmMedium: 'organic' }),
      lead({ utmSource: 'google' }),
    ]);
    const res = await buildService(tx).getPerformance(TENANT, {});
    const leads = Object.fromEntries(res.rows.map((r) => [r.channelId, r.leadsCount]));
    expect(leads).toEqual({ ads: 1, seo: 2, 'seo-2': 0 });
  });

  it('un cliente que ya se fue cuenta como cliente pero no en la cuota ni en el payback', async () => {
    const tx = buildTx();
    tx.marketingChannel.findMany.mockResolvedValue([channel({ type: 'physical' })]);
    tx.expense.groupBy.mockResolvedValue([{ marketingChannelId: 'chan-1', _sum: { amount: 50 } }]);
    tx.contract.findMany.mockResolvedValue([contract({ status: 'ended' })]);
    tx.lead.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([lead({ convertedContractId: 'ct-1', source: 'google_verano' })]);
    const res = await buildService(tx).getPerformance(TENANT, {});
    expect(res.rows[0]).toMatchObject({
      wonCount: 1,
      liveCount: 0,
      mrrGenerated: 0,
      cac: 50,
      paybackMonths: null,
    });
  });

  it('un contrato con la promoción del canal y sin contacto cuenta para el canal', async () => {
    const tx = buildTx();
    tx.marketingChannel.findMany.mockResolvedValue([
      channel({ id: 'flyer', type: 'physical', utmSourceMatch: 'flyer', promotionId: 'promo-1' }),
    ]);
    tx.contract.findMany.mockResolvedValue([contract({ id: 'ct-9', promotionId: 'promo-1' })]);
    tx.lead.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const res = await buildService(tx).getPerformance(TENANT, {});
    expect(res.rows[0]).toMatchObject({ channelId: 'flyer', wonCount: 1, liveCount: 1 });
  });

  it('un canal borrado sale solo si tuvo gasto o resultados en el periodo', async () => {
    const tx = buildTx();
    tx.marketingChannel.findMany.mockResolvedValue([
      channel({ id: 'gone-with-cost', utmSourceMatch: 'a', deletedAt: new Date() }),
      channel({ id: 'gone-empty', utmSourceMatch: 'b', deletedAt: new Date() }),
    ]);
    tx.expense.groupBy.mockResolvedValue([
      { marketingChannelId: 'gone-with-cost', _sum: { amount: 80 } },
    ]);
    const res = await buildService(tx).getPerformance(TENANT, {});
    expect(res.rows.map((r) => [r.channelId, r.deleted])).toEqual([['gone-with-cost', true]]);
  });

  it('sin permiso para ver gastos ni cobros, los importes no salen', async () => {
    const tx = buildTx();
    tx.marketingChannel.findMany.mockResolvedValue([channel({ type: 'physical' })]);
    tx.contract.findMany.mockResolvedValue([contract({})]);
    tx.lead.findMany
      .mockResolvedValueOnce([lead({ source: 'google_verano' })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([lead({ convertedContractId: 'ct-1', source: 'google_verano' })]);
    const viewer: MarketingViewer = { revenue: false, cost: false, facilityScope: null };
    const res = await buildService(tx).getPerformance(TENANT, {}, viewer);
    // Ni se consultan los gastos.
    expect(tx.expense.groupBy).not.toHaveBeenCalled();
    expect(res.rows[0]).toMatchObject({
      cost: 0,
      costPerLead: null,
      cac: null,
      mrrGenerated: 0,
      paybackMonths: null,
      leadsCount: 1,
      wonCount: 1,
    });
    expect(res.money).toEqual({ revenue: false, cost: false });
  });

  it('fechas no válidas o al revés → 400', async () => {
    const service = buildService(buildTx());
    await expect(service.getPerformance(TENANT, { from: 'xyz' })).rejects.toMatchObject({
      response: { code: 'invalid_date' },
    });
    await expect(
      service.getPerformance(TENANT, { from: '2026-05-10', to: '2026-05-01' }),
    ).rejects.toMatchObject({ response: { code: 'invalid_date' } });
  });

  it('ordena por coste desc', async () => {
    const tx = buildTx();
    tx.marketingChannel.findMany.mockResolvedValue([
      channel({ id: 'low-cost', utmSourceMatch: 'low' }),
      channel({ id: 'high-cost', utmSourceMatch: 'high' }),
    ]);
    tx.expense.groupBy.mockResolvedValue([
      { marketingChannelId: 'low-cost', _sum: { amount: 50 } },
      { marketingChannelId: 'high-cost', _sum: { amount: 300 } },
    ]);
    const res = await buildService(tx).getPerformance(TENANT, {});
    expect(res.rows.map((r) => r.channelId)).toEqual(['high-cost', 'low-cost']);
  });

  it('el canal guardado en el contacto manda sobre su origen, y el último contacto va a la reserva', async () => {
    const tx = buildTx();
    tx.marketingChannel.findMany.mockResolvedValue([
      channel({ id: 'flyer', type: 'physical', utmSourceMatch: 'flyer' }),
      channel({ id: 'portal', type: 'real_estate_portal', utmSourceMatch: 'idealista' }),
    ]);
    tx.contract.findMany.mockResolvedValue([contract({ id: 'ct-1' })]);
    const won = lead({
      convertedContractId: 'ct-1',
      // Llegó por el flyer (guardado) aunque su origen se renombrara después…
      source: 'otro',
      marketingChannelId: 'flyer',
      // …y reservó desde Idealista.
      metadata: { bookingUtm: { source: 'idealista', medium: null, campaign: null } },
    });
    tx.lead.findMany
      .mockResolvedValueOnce([lead({ source: 'otro', marketingChannelId: 'flyer' })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([won]);
    const first = await buildService(tx).getPerformance(TENANT, {});
    expect(Object.fromEntries(first.rows.map((r) => [r.channelId, r.wonCount]))).toEqual({
      flyer: 1,
      portal: 0,
    });
    expect(first.rows.find((r) => r.channelId === 'flyer')!.leadsCount).toBe(1);

    tx.lead.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([won]);
    const last = await buildService(tx).getPerformance(TENANT, { model: 'last' });
    expect(Object.fromEntries(last.rows.map((r) => [r.channelId, r.wonCount]))).toEqual({
      flyer: 0,
      portal: 1,
    });
    expect(last.model).toBe('last');
  });

  it('el cupón del canal le da sus contratos, y el cobrado da el retorno', async () => {
    const tx = buildTx();
    tx.marketingChannel.findMany.mockResolvedValue([
      channel({ id: 'flyer', type: 'physical', utmSourceMatch: 'flyer', couponId: 'cup-1' }),
    ]);
    tx.expense.groupBy.mockResolvedValue([{ marketingChannelId: 'flyer', _sum: { amount: 100 } }]);
    tx.contract.findMany.mockResolvedValue([contract({ id: 'ct-5' })]);
    tx.couponRedemption.findMany.mockResolvedValue([{ contractId: 'ct-5', couponId: 'cup-1' }]);
    tx.lead.findMany.mockResolvedValue([]);
    tx.$queryRaw
      // Visitas por origen.
      .mockResolvedValueOnce([{ source: 'flyer', medium: 'offline', campaign: '', n: 12 }])
      // Cobrado por contrato.
      .mockResolvedValueOnce([{ contract_id: 'ct-5', net: 250 }]);
    const res = await buildService(tx).getPerformance(TENANT, {});
    expect(res.rows[0]).toMatchObject({
      channelId: 'flyer',
      visitors: 12,
      wonCount: 1,
      paidCount: 1,
      collected: 250,
      roas: 2.5,
    });
  });
});
