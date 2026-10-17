import { describe, expect, it } from 'vitest';

import { buildTenantLegalDoc, missingLegalHolderData, parseWebLegal } from './legal';

const holder = {
  name: 'Trasteros García SL',
  taxId: 'B12345674',
  address: 'Calle Mayor 1, 46001 Valencia',
  email: 'hola@garcia.es',
  phone: '600000000',
};

describe('textos legales del tenant', () => {
  it('el aviso legal identifica al titular (LSSI art. 10)', () => {
    const md = buildTenantLegalDoc('aviso-legal', {
      holder,
      websiteUrl: 'https://garcia.es',
      analytics: false,
      whatsapp: false,
    });
    expect(md).toContain('Trasteros García SL');
    expect(md).toContain('B12345674');
    expect(md).toContain('Calle Mayor 1');
    expect(md).toContain('https://garcia.es');
  });

  it('cookies y privacidad mencionan Google Analytics y WhatsApp solo si se usan', () => {
    const base = { holder, websiteUrl: 'https://garcia.es', whatsapp: false };
    expect(buildTenantLegalDoc('cookies', { ...base, analytics: true })).toContain(
      'Google Analytics',
    );
    expect(buildTenantLegalDoc('cookies', { ...base, analytics: false })).not.toContain(
      'Google Analytics',
    );
    expect(
      buildTenantLegalDoc('privacidad', { ...base, analytics: false, whatsapp: true }),
    ).toContain('WhatsApp');
  });

  it('avisa de los datos del titular que faltan', () => {
    expect(missingLegalHolderData({ ...holder, taxId: null, address: null })).toEqual([
      'NIF',
      'domicilio',
    ]);
  });

  it('parseWebLegal ignora vacíos y basura', () => {
    expect(parseWebLegal({ privacy: '  ', cookies: 'Mi texto', otro: 1 })).toEqual({
      cookies: 'Mi texto',
    });
    expect(parseWebLegal(null)).toEqual({});
  });
});
