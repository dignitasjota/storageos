import { describe, expect, it } from 'vitest';

import { isValidSpanishTaxId, missingFiscalData, normalizeTaxId } from './billing-details';

describe('isValidSpanishTaxId', () => {
  it('acepta DNI, NIE y CIF con control correcto', () => {
    expect(isValidSpanishTaxId('12345678Z')).toBe(true);
    expect(isValidSpanishTaxId('X1234567L')).toBe(true);
    expect(isValidSpanishTaxId('B12345674')).toBe(true);
    expect(isValidSpanishTaxId('Q2826000H')).toBe(true);
  });
  it('rechaza control erróneo o formato desconocido', () => {
    expect(isValidSpanishTaxId('12345678A')).toBe(false);
    expect(isValidSpanishTaxId('B12345675')).toBe(false);
    expect(isValidSpanishTaxId('ABC')).toBe(false);
  });
  it('normaliza espacios, guiones y prefijo ES', () => {
    expect(normalizeTaxId('es b-1234567 4')).toBe('B12345674');
    expect(isValidSpanishTaxId('ES-B12345674')).toBe(true);
  });
});

describe('missingFiscalData', () => {
  it('lista lo que falta y valida el NIF solo en España', () => {
    expect(
      missingFiscalData({
        name: 'Acme',
        taxId: '',
        address: null,
        city: 'Madrid',
        postalCode: '28001',
      }),
    ).toEqual(['NIF', 'Dirección']);
    expect(
      missingFiscalData({
        name: 'Acme',
        taxId: 'FR123',
        address: 'Rue 1',
        city: 'Paris',
        postalCode: '75001',
        country: 'FR',
      }),
    ).toEqual([]);
    expect(
      missingFiscalData({ name: 'Acme', taxId: '123', address: 'C/1', city: 'X', postalCode: '1' }),
    ).toEqual(['NIF válido']);
  });
});
