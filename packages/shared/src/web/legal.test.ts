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
    const chat = buildTenantLegalDoc('privacidad', { ...base, analytics: false, webChat: true });
    expect(chat).toContain('Chat de la web');
    expect(chat).toContain('Anthropic');
    expect(buildTenantLegalDoc('privacidad', { ...base, analytics: false })).not.toContain(
      'Chat de la web',
    );
  });

  it('las condiciones de contratación usan los datos del negocio y sus locales', () => {
    const md = buildTenantLegalDoc('condiciones-contratacion', {
      holder,
      websiteUrl: 'https://garcia.es',
      analytics: false,
      whatsapp: false,
      tradeName: 'Trasteros García',
      facilities: ['Centro Norte: Calle A 1, 46001 Valencia', 'Centro Sur: Calle B 2'],
    });
    expect(md).toContain('bajo el nombre comercial **Trasteros García**');
    expect(md).toContain('**Razón social:** Trasteros García SL');
    expect(md).toContain('- **NIF:** B12345674');
    expect(md).toContain('  - Centro Sur: Calle B 2');
    expect(md).toContain('declaración inequívoca enviada a hola@garcia.es');
    expect(md).toContain('[política de privacidad](./privacidad)');
    // Prohibidos, impago y revisión de la cuota alineados con el contrato.
    expect(md).toContain('Guardar armas, municiones o explosivos.');
    expect(md).toContain('ocho (8) semanas desde el impago');
    expect(md).toContain('Índice de Precios al Consumo (IPC)');
    expect(md).toContain('gastos de gestión por el importe publicado por Trasteros García');
    // Sin huecos tipo «[RAZÓN SOCIAL]» por rellenar.
    expect(md).not.toMatch(/\[[A-ZÁÉÍÓÚÑ ]{4,}\]/);
  });

  it('sin email ni locales no deja huecos en las condiciones', () => {
    const md = buildTenantLegalDoc('condiciones-contratacion', {
      holder: { ...holder, email: null, phone: null, taxId: null },
      websiteUrl: 'https://garcia.es',
      analytics: false,
      whatsapp: false,
    });
    expect(md).not.toContain('Nombre comercial');
    expect(md).not.toContain('NIF');
    expect(md).toContain('a través de los datos de contacto de esta web');
    expect(md).toContain('- **Sitio web:** https://garcia.es');
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
