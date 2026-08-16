import { GoogleAdsClient } from '../google-ads.client';

function mockFetch(
  impl: (url: string, init?: RequestInit) => { ok: boolean; status: number; body: unknown },
) {
  return jest.spyOn(global, 'fetch').mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const r = impl(url, init as RequestInit);
    return Promise.resolve({ ok: r.ok, status: r.status, json: async () => r.body } as Response);
  });
}

const CREDS = {
  clientId: 'client-1',
  clientSecret: 'secret-1',
  developerToken: 'dev-token-1',
  refreshToken: 'refresh-1',
  customerId: '123-456-7890',
};

describe('GoogleAdsClient', () => {
  afterEach(() => jest.restoreAllMocks());

  it('renueva el token y lanza la búsqueda con los headers correctos (customerId sin guiones)', async () => {
    const spy = mockFetch((url) => {
      if (url.includes('oauth2.googleapis.com')) {
        return { ok: true, status: 200, body: { access_token: 'tok_abc', expires_in: 3600 } };
      }
      return { ok: true, status: 200, body: { results: [] } };
    });
    await new GoogleAdsClient(CREDS).testConnection();

    const tokenCall = spy.mock.calls.find(([u]) => String(u).includes('oauth2.googleapis.com'))!;
    expect((tokenCall[1] as RequestInit).method).toBe('POST');

    const searchCall = spy.mock.calls.find(([u]) => String(u).includes('googleAds:search'))!;
    expect(String(searchCall[0])).toContain('/customers/1234567890/googleAds:search');
    const headers = (searchCall[1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok_abc');
    expect(headers['developer-token']).toBe('dev-token-1');
  });

  it('getCampaignSpend convierte cost_micros a euros y agrupa por fecha', async () => {
    mockFetch((url) => {
      if (url.includes('oauth2.googleapis.com')) {
        return { ok: true, status: 200, body: { access_token: 'tok', expires_in: 3600 } };
      }
      return {
        ok: true,
        status: 200,
        body: {
          results: [
            { segments: { date: '2026-08-01' }, metrics: { costMicros: '12340000' } },
            { segments: { date: '2026-08-02' }, metrics: { costMicros: '5000000' } },
          ],
        },
      };
    });
    const rows = await new GoogleAdsClient(CREDS).getCampaignSpend(
      '999888777',
      '2026-08-01',
      '2026-08-02',
    );
    expect(rows).toEqual([
      { date: '2026-08-01', cost: 12.34 },
      { date: '2026-08-02', cost: 5 },
    ]);
  });

  it('lanza con un mensaje claro si el token es inválido', async () => {
    mockFetch(() => ({
      ok: false,
      status: 400,
      body: { error_description: 'invalid_grant' },
    }));
    await expect(new GoogleAdsClient(CREDS).testConnection()).rejects.toThrow('invalid_grant');
  });

  it('lanza con el mensaje de error de la API ante un fallo HTTP en la búsqueda', async () => {
    mockFetch((url) => {
      if (url.includes('oauth2.googleapis.com')) {
        return { ok: true, status: 200, body: { access_token: 'tok', expires_in: 3600 } };
      }
      return {
        ok: false,
        status: 403,
        body: { error: { message: 'developer token not approved' } },
      };
    });
    await expect(new GoogleAdsClient(CREDS).testConnection()).rejects.toThrow(
      'developer token not approved',
    );
  });

  it('incluye login-customer-id cuando la cuenta está gestionada bajo un MCC', async () => {
    const spy = mockFetch((url) => {
      if (url.includes('oauth2.googleapis.com')) {
        return { ok: true, status: 200, body: { access_token: 'tok', expires_in: 3600 } };
      }
      return { ok: true, status: 200, body: { results: [] } };
    });
    await new GoogleAdsClient({ ...CREDS, loginCustomerId: '999-888-7777' }).testConnection();
    const searchCall = spy.mock.calls.find(([u]) => String(u).includes('googleAds:search'))!;
    const headers = (searchCall[1] as RequestInit).headers as Record<string, string>;
    expect(headers['login-customer-id']).toBe('9998887777');
  });
});
