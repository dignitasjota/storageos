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
        host: '@',
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

  // Respuesta real de Brevo (2026-09-30) para un dominio ya autenticado en la cuenta.
  const REAL_EXISTING = {
    domain: 'guardalobox.es',
    verified: true,
    authenticated: true,
    dns_records: {
      dkim_record: null,
      dkim1Record: {
        type: 'CNAME',
        value: 'b1.guardalobox-es.dkim.brevo.com',
        host_name: 'brevo1._domainkey',
        status: true,
      },
      dkim2Record: {
        type: 'CNAME',
        value: 'b2.guardalobox-es.dkim.brevo.com',
        host_name: 'brevo2._domainkey',
        status: true,
      },
      brevo_code: { type: 'TXT', value: 'brevo-code:212cd94', host_name: '@', status: true },
      dmarc_record: {
        type: 'TXT',
        value: 'v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com',
        host_name: '_dmarc',
        status: true,
      },
    },
  };

  it('si el dominio ya existe en Brevo lo adopta sin intentar el alta', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(REAL_EXISTING), { status: 200 }));
    const state = await client().create('guardalobox.es');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
    expect(state.authenticated).toBe(true);
    expect(state.records).toEqual([
      {
        label: 'Firma DKIM',
        type: 'CNAME',
        host: 'brevo1._domainkey',
        value: 'b1.guardalobox-es.dkim.brevo.com',
        ok: true,
      },
      {
        label: 'Firma DKIM',
        type: 'CNAME',
        host: 'brevo2._domainkey',
        value: 'b2.guardalobox-es.dkim.brevo.com',
        ok: true,
      },
      {
        label: 'Código de verificación de Brevo',
        type: 'TXT',
        host: '@',
        value: 'brevo-code:212cd94',
        ok: true,
      },
      {
        label: 'DMARC',
        type: 'TXT',
        host: '_dmarc',
        value: 'v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com',
        ok: true,
      },
    ]);
  });

  it('si no existe (404) lo da de alta', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Domain not found' }), { status: 404 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            dns_records: {
              brevo_code: { type: 'TXT', value: 'brevo-code:9', host_name: '@', status: false },
            },
          }),
          { status: 201 },
        ),
      );
    const state = await client().create('nuevo.es');
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('POST');
    expect(state).toEqual({
      authenticated: false,
      records: [
        {
          label: 'Código de verificación de Brevo',
          type: 'TXT',
          host: '@',
          value: 'brevo-code:9',
          ok: false,
        },
      ],
    });
  });

  it('otros errores se propagan (clave inválida) e indican el paso', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Key not found' }), { status: 401 }),
      );
    await expect(client().create('garcia.es')).rejects.toThrow('Key not found');

    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'not found' }), { status: 404 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'invalid domain' }), { status: 400 }),
      );
    await expect(client().create('garcia.es')).rejects.toThrow(
      'alta del dominio (400): invalid domain',
    );
  });
});
