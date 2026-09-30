import { parseDnsRecords } from '../brevo-domains.client';

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
