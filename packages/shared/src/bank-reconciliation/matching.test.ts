import { describe, expect, it } from 'vitest';

import {
  bankTextContains,
  findInvoiceSubset,
  guessPayerPattern,
  nameMatches,
  normalizeBankText,
} from './matching';

describe('texto de los movimientos del banco', () => {
  it('mayúsculas, sin acentos ni signos', () => {
    expect(normalizeBankText('Transferencia de JOSÉ García-López, ref: FA/2026/0010')).toBe(
      'TRANSFERENCIA DE JOSE GARCIA LOPEZ REF FA 2026 0010',
    );
  });

  it('un patrón casa con palabras enteras', () => {
    expect(bankTextContains('TRANSFERENCIA DE GARCIA LOPEZ JOSE', 'García López')).toBe(true);
    expect(bankTextContains('TRANSFERENCIA GARCIALOPEZ', 'GARCIA')).toBe(false);
    expect(bankTextContains('ALGO', 'AB')).toBe(false);
  });

  it('el nombre del inquilino, en cualquier orden y sin la forma jurídica', () => {
    expect(nameMatches('TRANSFERENCIA DE GARCIA LOPEZ JOSE', 'José García López')).toBe(true);
    expect(nameMatches('TRANSFERENCIA DE GARCIA JOSE', 'José García López')).toBe(false);
    expect(nameMatches('TRANSF TRASTEROS NORTE SL', 'Trasteros Norte, S.L.')).toBe(true);
    // Un nombre de una palabra corta no basta.
    expect(nameMatches('PAGO ANA', 'Ana')).toBe(false);
  });

  it('lo que identifica al ordenante, para recordarlo', () => {
    expect(
      guessPayerPattern('TRANSFERENCIA DE GARCIA LOPEZ JOSE CONCEPTO TRASTERO NOVIEMBRE'),
    ).toBe('GARCIA LOPEZ JOSE');
    expect(guessPayerPattern('BIZUM DE ANA PEREZ')).toBe('ANA PEREZ');
    expect(guessPayerPattern('RECIBO 12345 IBERDROLA')).toBe('IBERDROLA');
    expect(guessPayerPattern('TRANSFERENCIA 2026')).toBe('');
  });
});

describe('facturas de un inquilino que suman el ingreso', () => {
  const invoices = [
    { id: 'a', cents: 6050 },
    { id: 'b', cents: 12100 },
    { id: 'c', cents: 3025 },
  ];
  it('dos o más, la más antigua primero', () => {
    expect(findInvoiceSubset(invoices, 18150)).toEqual(['a', 'b']);
    expect(findInvoiceSubset(invoices, 9075)).toEqual(['a', 'c']);
    expect(findInvoiceSubset(invoices, 21175)).toEqual(['a', 'b', 'c']);
  });
  it('una sola o ninguna combinación: null', () => {
    expect(findInvoiceSubset(invoices, 6050)).toBeNull();
    expect(findInvoiceSubset(invoices, 100)).toBeNull();
  });
  it('con muchas facturas la búsqueda tiene un tope', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ id: `f${i}`, cents: 100 + i }));
    expect(findInvoiceSubset(many, 615)).toEqual(['f0', 'f1', 'f2', 'f3', 'f4', 'f5']);
    // Solo las seis más altas suman 669: con pocos pasos no se llega.
    expect(findInvoiceSubset(many, 669, 6, 50)).toBeNull();
    expect(findInvoiceSubset(many, 669, 6, 1_000_000)).toEqual([
      'f9',
      'f10',
      'f11',
      'f12',
      'f13',
      'f14',
    ]);
  });
});
