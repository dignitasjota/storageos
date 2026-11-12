import { describe, expect, it } from 'vitest';

import { CreatePlatformLeadSchema, fillPlatformLeadTemplate, platformLeadName } from './leads';

describe('leads del panel admin', () => {
  it('el nombre es la empresa, o la persona, o el email', () => {
    expect(platformLeadName({ companyName: 'Trasteros Sol', contactName: 'Ana' })).toBe(
      'Trasteros Sol',
    );
    expect(platformLeadName({ companyName: '  ', contactName: 'Ana Pérez' })).toBe('Ana Pérez');
    expect(platformLeadName({ email: 'ana@ej.com' })).toBe('ana@ej.com');
    expect(platformLeadName({})).toBe('Sin nombre');
  });

  it('rellena {empresa} y {nombre} (el nombre de pila)', () => {
    expect(
      fillPlatformLeadTemplate('Hola {nombre}, sobre {empresa}…', {
        companyName: 'Trasteros Sol',
        contactName: 'Ana Pérez',
      }),
    ).toBe('Hola Ana, sobre Trasteros Sol…');
    expect(fillPlatformLeadTemplate('Hola {nombre}', { companyName: 'Trasteros Sol' })).toBe(
      'Hola Trasteros Sol',
    );
  });

  it('el alta a mano pide empresa o persona y email o teléfono', () => {
    expect(CreatePlatformLeadSchema.safeParse({ contactName: 'Ana' }).success).toBe(false);
    expect(CreatePlatformLeadSchema.safeParse({ email: 'ana@ej.com' }).success).toBe(false);
    const ok = CreatePlatformLeadSchema.safeParse({ companyName: 'Sol', phone: '600000000' });
    expect(ok.success && ok.data.source).toBe('phone');
  });
});
