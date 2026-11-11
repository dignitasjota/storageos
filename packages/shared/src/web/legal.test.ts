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
    // Prohibidos, impago, baja, fianza y seguro alineados con el contrato.
    expect(md).toContain('Guardar armas, municiones o explosivos.');
    expect(md).toContain('Guardar baterías de litio dañadas, hinchadas o manipuladas.');
    expect(md).not.toContain('razonablemente no deba guardarse');
    expect(md).not.toContain('abandonados');
    expect(md).toContain('el cliente podrá pedir cita para retirar sus pertenencias');
    expect(md).toContain('Índice de Precios al Consumo (IPC)');
    expect(md).toContain('el recargo y los gastos de gestión que figuren en el contrato');
    expect(md).toContain('autoriza a Trasteros García a cobrar en ella cada cuota');
    expect(md).toContain('Surte efecto el último día del mes en que se cumpla esa antelación');
    expect(md).toContain('en un plazo máximo de 15 días desde que el cliente entregue el espacio');
    expect(md).toContain('Trasteros García no asegura los bienes que guarda el cliente');
    // Desistimiento: el modelo de formulario y la casilla de inicio inmediato.
    expect(md).toContain('**Modelo de formulario de desistimiento**');
    expect(md).toContain('A la atención de Trasteros García SL');
    expect(md).toContain('lo hace con una casilla al firmar el contrato');
    // Sin huecos tipo «[RAZÓN SOCIAL]» por rellenar.
    expect(md).not.toMatch(/\[[A-ZÁÉÍÓÚÑ ]{4,}\]/);
  });

  it('la baja y la fianza siguen los ajustes del negocio', () => {
    const md = buildTenantLegalDoc('condiciones-contratacion', {
      holder,
      websiteUrl: 'https://garcia.es',
      analytics: false,
      whatsapp: false,
      moveOutEndOfMonth: false,
      depositReturnDays: 30,
    });
    expect(md).toContain('Surte efecto el día que indique el cliente');
    expect(md).not.toContain('Surte efecto el último día del mes');
    expect(md).toContain('en un plazo máximo de 30 días');
  });

  it('la privacidad explica el control de accesos y la videovigilancia con sus plazos', () => {
    const md = buildTenantLegalDoc('privacidad', {
      holder,
      websiteUrl: 'https://garcia.es',
      analytics: false,
      whatsapp: false,
      accessLogDays: 90,
    });
    expect(md).toContain('**Control de accesos:**');
    expect(md).toContain('**Videovigilancia:**');
    expect(md).toContain('artículo 22 de la Ley Orgánica 3/2018');
    expect(md).toContain('Los registros del control de accesos se borran a los 90 días');
    expect(md).toContain('como máximo al mes');
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
