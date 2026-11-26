import { normalizeSeoGa4Rows } from '@storageos/shared';

import { Ga4Client } from '../ga4.client';

import type { ConfigService } from '@nestjs/config';

/**
 * SEO Avanzado, PR 12: la consulta del tráfico orgánico por página de entrada
 * (la petición a la Data API sin llamar a Google) y la normalización de la
 * página con la misma clave que las conversiones.
 */
describe('Ga4Client.organicLandingRows', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  function realClient() {
    // Sin simulador: la petición va a `account.request`, que se sustituye aquí.
    process.env.NODE_ENV = 'development';
    delete process.env.GSC_MODE;
    const config = { get: () => '' } as unknown as ConfigService<never, true>;
    const client = new Ga4Client(config as never);
    const request = jest.fn().mockResolvedValue({
      rows: [
        {
          dimensionValues: [
            { value: '20261120' },
            { value: 'www.Guardalobox.es' },
            { value: '/precios?utm_source=newsletter' },
          ],
          metricValues: [
            { value: '10' },
            { value: '9' },
            { value: '4' },
            { value: '30.5' },
            { value: '25' },
            { value: '1.5' },
          ],
        },
      ],
    });
    (client as unknown as { account: unknown }).account = {
      request,
      configured: true,
      email: 'seo@x.iam.gserviceaccount.com',
    };
    return { client, request };
  }

  it('pide solo lo orgánico de Google por fecha, host y página de entrada', async () => {
    const { client, request } = realClient();
    const rows = await client.organicLandingRows('123456789', '2026-11-01', '2026-11-20');
    expect(request).toHaveBeenCalledTimes(1);
    const [, method, url, body] = request.mock.calls[0] as [
      string,
      string,
      string,
      Record<string, unknown>,
    ];
    expect(method).toBe('POST');
    expect(url).toContain('/properties/123456789:runReport');
    expect(body.dimensions).toEqual([
      { name: 'date' },
      { name: 'hostName' },
      { name: 'landingPagePlusQueryString' },
    ]);
    expect((body.metrics as { name: string }[]).map((m) => m.name)).toEqual([
      'sessions',
      'totalUsers',
      'engagedSessions',
      'averageSessionDuration',
      'screenPageViews',
      'keyEvents',
    ]);
    expect(JSON.stringify(body.dimensionFilter)).toContain('"value":"Organic Search"');
    expect(JSON.stringify(body.dimensionFilter)).toContain('"fieldName":"sessionSource"');
    expect(rows).toEqual([
      {
        date: '2026-11-20',
        host: 'www.Guardalobox.es',
        landing: '/precios?utm_source=newsletter',
        sessions: 10,
        users: 9,
        engagedSessions: 4,
        averageSessionDuration: 30.5,
        pageViews: 25,
        keyEvents: 1.5,
      },
    ]);
  });

  it('normaliza la página como las conversiones y junta las variantes del mismo día', () => {
    const base = {
      date: '2026-11-20',
      users: 1,
      engagedSessions: 1,
      averageSessionDuration: 60,
      pageViews: 2,
      keyEvents: 0,
    };
    const out = normalizeSeoGa4Rows([
      { ...base, host: 'www.a.es', landing: '/precios?utm_source=x', sessions: 2 },
      { ...base, host: 'a.es', landing: '/precios/', sessions: 3 },
      { ...base, host: 'a.es', landing: '/s/mi-negocio/contacto', sessions: 1 },
      { ...base, host: '(not set)', landing: '(not set)', sessions: 1 },
    ]);
    expect(out).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          host: 'a.es',
          landingPath: '/precios',
          sessions: 5,
          durationSeconds: 300,
        }),
        expect.objectContaining({ host: 'a.es', landingPath: '/contacto', sessions: 1 }),
        expect.objectContaining({ host: '', landingPath: '', sessions: 1 }),
      ]),
    );
    expect(out).toHaveLength(3);
  });

  it('con NODE_ENV=test responde el simulador y la propiedad 403403403 no da acceso', async () => {
    process.env.NODE_ENV = 'test';
    const client = new Ga4Client({ get: () => '' } as never);
    const rows = await client.organicLandingRows('123456789', '2026-11-01', '2026-11-02');
    expect(rows.length).toBe(8);
    await expect(
      client.organicLandingRows('403403403', '2026-11-01', '2026-11-01'),
    ).rejects.toThrow(/permissions/);
  });
});
