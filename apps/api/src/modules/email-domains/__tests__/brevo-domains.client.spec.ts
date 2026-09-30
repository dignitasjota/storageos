import { BrevoDomainsClient, parseDnsRecords } from '../brevo-domains.client';

import type { Env } from '../../../config/env.schema';
import type { ConfigService } from '@nestjs/config';

describe('parseDnsRecords (respuesta de Brevo)', () => {
  it('normaliza registros, etiqueta y resuelve @ al dominio', () => {
    const records = parseDnsRecords(
      {
        dkim_record: {
          type: 'txt',
          value: 'k=rsa;p=ABC',
          host_name: 'mail._domainkey',
          status: true,
        },
        brevo_code: { type: 'TXT', value: 'brevo-code:123', host_name: '@', status: false },
        dmarc_record: { type: 'TXT', value: 'v=DMARC1; p=none', host_name: '_dmarc' },
        rara: 'no es un objeto',
        incompleto: { type: 'TXT' },
      },
      'garcia.es',
    );
    expect(records).toEqual([
      { label: 'Firma DKIM', type: 'TXT', host: 'mail._domainkey', value: 'k=rsa;p=ABC', ok: true },
      {
        label: 'Código de verificación de Brevo',
        type: 'TXT',
        host: 'garcia.es',
        value: 'brevo-code:123',
        ok: false,
      },
      { label: 'DMARC', type: 'TXT', host: '_dmarc', value: 'v=DMARC1; p=none', ok: false },
    ]);
  });

  it('tolera respuestas vacías o con otro formato', () => {
    expect(parseDnsRecords(undefined, 'x.es')).toEqual([]);
    expect(parseDnsRecords('nada', 'x.es')).toEqual([]);
  });
});

describe('BrevoDomainsClient.create', () => {
  const OLD_ENV = process.env.NODE_ENV;
  beforeAll(() => {
    process.env.NODE_ENV = 'development';
  });
  afterAll(() => {
    process.env.NODE_ENV = OLD_ENV;
  });
  afterEach(() => jest.restoreAllMocks());

  function client(): BrevoDomainsClient {
    return new BrevoDomainsClient({
      get: () => 'xkeysib-1',
    } as unknown as ConfigService<Env, true>);
  }

  it('si el dominio ya existe en la cuenta de Brevo, lo adopta con su estado', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 'invalid_parameter', message: 'Domain already exists' }),
          {
            status: 400,
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authenticated: true,
            dns_records: {
              brevo_code: { type: 'TXT', value: 'brevo-code:1', host_name: '@', status: true },
            },
          }),
          { status: 200 },
        ),
      );
    const state = await client().create('garcia.es');
    expect(state.authenticated).toBe(true);
    expect(state.records[0]?.value).toBe('brevo-code:1');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://api.brevo.com/v3/senders/domains/garcia.es');
  });

  it('otros errores del alta se propagan', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Key not found' }), { status: 401 }),
      );
    await expect(client().create('garcia.es')).rejects.toThrow('Key not found');
  });
});
