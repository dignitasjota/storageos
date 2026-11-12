import { describe, expect, it } from 'vitest';

import { findReturnCode, returnCodeLabel } from './return-codes';

describe('códigos de devolución SEPA', () => {
  it('da el código con lo que significa', () => {
    expect(returnCodeLabel('AM04')).toBe('AM04 · Saldo insuficiente');
    expect(returnCodeLabel('XX99')).toBeNull();
    expect(returnCodeLabel(null)).toBeNull();
  });

  it('encuentra el código en el concepto del banco', () => {
    expect(findReturnCode('DEVOLUCION RECIBO MOTIVO: MD06 REF 123')).toBe('MD06');
    expect(findReturnCode('devolucion am04 saldo insuficiente')).toBe('AM04');
    // Pegado a otras letras o cifras no cuenta.
    expect(findReturnCode('REFAM04X 1234')).toBeNull();
    expect(findReturnCode('TRANSFERENCIA RECIBIDA')).toBeNull();
    expect(findReturnCode(undefined)).toBeNull();
  });
});
