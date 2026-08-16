import { MetaAdsClient } from '../meta-ads.client';

function mockFetch(impl: (url: string) => { ok: boolean; status: number; body: unknown }) {
  return jest.spyOn(global, 'fetch').mockImplementation((input) => {
    const url = typeof input === 'string' ? input : input.toString();
    const r = impl(url);
    return Promise.resolve({ ok: r.ok, status: r.status, json: async () => r.body } as Response);
  });
}

describe('MetaAdsClient', () => {
  afterEach(() => jest.restoreAllMocks());

  it('testConnection normaliza el ad account id con el prefijo act_', async () => {
    const spy = mockFetch(() => ({ ok: true, status: 200, body: { id: 'act_555' } }));
    await new MetaAdsClient({ accessToken: 'tok', adAccountId: '555' }).testConnection();
    expect(String(spy.mock.calls[0]![0])).toContain('/act_555?');
  });

  it('no duplica el prefijo si ya viene con act_', async () => {
    const spy = mockFetch(() => ({ ok: true, status: 200, body: { id: 'act_555' } }));
    await new MetaAdsClient({ accessToken: 'tok', adAccountId: 'act_555' }).testConnection();
    expect(String(spy.mock.calls[0]![0])).toContain('/act_555?');
    expect(String(spy.mock.calls[0]![0])).not.toContain('act_act_555');
  });

  it('getCampaignSpend mapea date_start/spend a filas', async () => {
    mockFetch(() => ({
      ok: true,
      status: 200,
      body: {
        data: [
          { date_start: '2026-08-01', date_stop: '2026-08-01', spend: '12.5' },
          { date_start: '2026-08-02', date_stop: '2026-08-02', spend: '0' },
        ],
      },
    }));
    const rows = await new MetaAdsClient({ accessToken: 'tok', adAccountId: '1' }).getCampaignSpend(
      '9988',
      '2026-08-01',
      '2026-08-02',
    );
    expect(rows).toEqual([
      { date: '2026-08-01', cost: 12.5 },
      { date: '2026-08-02', cost: 0 },
    ]);
  });

  it('lanza con el mensaje de error de la Graph API', async () => {
    mockFetch(() => ({
      ok: true,
      status: 200,
      body: { error: { message: 'Error validating access token' } },
    }));
    await expect(
      new MetaAdsClient({ accessToken: 'bad', adAccountId: '1' }).testConnection(),
    ).rejects.toThrow('Error validating access token');
  });
});
