import { fillSecrets, maskSecrets, sealLinkTokens } from '../secret-vars';

describe('sealLinkTokens', () => {
  it('tapa el código de los enlaces que dan acceso y lo devuelve al enviar', () => {
    const secrets: Record<string, string> = {};
    const text =
      'Firma aquí: https://web.es/sign/0191a2b3-1111-2222-3333-444455556666.abcdef0123456789abcdef ' +
      'y descarga https://api.es/v1/public/invoices/AbCdEf_123-4567890xyz/pdf. ' +
      'Entra en https://web.es/portal/reset?token=qwertyuiopasdfghjkl';
    const sealed = sealLinkTokens(text, secrets);
    expect(Object.keys(secrets)).toHaveLength(3);
    expect(maskSecrets(sealed)).toBe(
      'Firma aquí: https://web.es/sign/•••• y descarga https://api.es/v1/public/invoices/••••/pdf. ' +
        'Entra en https://web.es/portal/reset?token=••••',
    );
    expect(fillSecrets(sealed, secrets)).toBe(text);
  });

  it('no toca los enlaces normales', () => {
    const secrets: Record<string, string> = {};
    const text = 'Mira https://web.es/precios y https://web.es/blog/oferta-de-verano-2026';
    expect(sealLinkTokens(text, secrets)).toBe(text);
    expect(secrets).toEqual({});
  });
});
