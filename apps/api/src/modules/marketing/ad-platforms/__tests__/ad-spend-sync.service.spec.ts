import { AdSpendSyncService } from '../ad-spend-sync.service';

import type { PrismaAdminService } from '../../../database/prisma-admin.service';
import type { PrismaService } from '../../../database/prisma.service';
import type { GoogleAdsSettingsService } from '../google-ads-settings.service';
import type { MetaAdsSettingsService } from '../meta-ads-settings.service';

interface TxMock {
  expense: { upsert: jest.Mock };
}

function buildTx(): TxMock {
  return { expense: { upsert: jest.fn().mockResolvedValue({}) } };
}

function buildService(tx: TxMock) {
  const prisma = {
    withTenant: <T>(fn: (t: TxMock) => Promise<T>) => fn(tx),
  } as unknown as PrismaService;
  const admin = {} as PrismaAdminService;
  const googleSettings = {} as GoogleAdsSettingsService;
  const metaSettings = {} as MetaAdsSettingsService;
  return new AdSpendSyncService(prisma, admin, googleSettings, metaSettings);
}

const TENANT = '019e3d20-aaaa-7c2f-bf37-6511065b9fc5';
const CHANNEL = {
  id: 'chan-1',
  name: 'Campaña Búsqueda Local',
  facilityId: null,
  type: 'google_ads',
  externalCampaignId: '999',
};

describe('AdSpendSyncService.upsertSpendExpenses', () => {
  it('crea un expense por cada día con gasto > 0, con el externalRef idempotente', async () => {
    const tx = buildTx();
    const service = buildService(tx);
    const result = await service.upsertSpendExpenses(TENANT, CHANNEL, 'google_ads', '999', [
      { date: '2026-08-01', cost: 12.34 },
      { date: '2026-08-02', cost: 5 },
    ]);
    expect(result).toEqual({ synced: 2, totalCost: 17.34 });
    expect(tx.expense.upsert).toHaveBeenCalledTimes(2);
    const [firstArgs] = tx.expense.upsert.mock.calls[0]!;
    expect(firstArgs.where).toEqual({ externalRef: 'google_ads:999:2026-08-01' });
    expect(firstArgs.create).toMatchObject({
      tenantId: TENANT,
      category: 'marketing',
      description: 'Google Ads — Campaña Búsqueda Local',
      amount: 12.34,
      marketingChannelId: 'chan-1',
      externalRef: 'google_ads:999:2026-08-01',
    });
    expect(firstArgs.update).toEqual({ amount: 12.34 });
  });

  it('omite los días sin gasto (cost <= 0)', async () => {
    const tx = buildTx();
    const service = buildService(tx);
    const result = await service.upsertSpendExpenses(TENANT, CHANNEL, 'meta_ads', '999', [
      { date: '2026-08-01', cost: 0 },
      { date: '2026-08-02', cost: 10 },
    ]);
    expect(result).toEqual({ synced: 1, totalCost: 10 });
    expect(tx.expense.upsert).toHaveBeenCalledTimes(1);
  });

  it('etiqueta la descripción según la plataforma', async () => {
    const tx = buildTx();
    const service = buildService(tx);
    await service.upsertSpendExpenses(TENANT, CHANNEL, 'meta_ads', '999', [
      { date: '2026-08-01', cost: 1 },
    ]);
    const [args] = tx.expense.upsert.mock.calls[0]!;
    expect(args.create.description).toBe('Meta Ads — Campaña Búsqueda Local');
    expect(args.create.externalRef).toBe('meta_ads:999:2026-08-01');
  });
});
