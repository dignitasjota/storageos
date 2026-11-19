import { isReservedExampleAddress } from '../reserved-address';

describe('isReservedExampleAddress', () => {
  it('reconoce los dominios reservados para ejemplos', () => {
    expect(isReservedExampleAddress('laura.martin@example.com')).toBe(true);
    expect(isReservedExampleAddress('Ana@Mail.Example.ORG')).toBe(true);
    expect(isReservedExampleAddress('x@negocio.test')).toBe(true);
    expect(isReservedExampleAddress('x@algo.invalid')).toBe(true);
  });

  it('deja pasar las direcciones reales', () => {
    expect(isReservedExampleAddress('ana@gmail.com')).toBe(false);
    expect(isReservedExampleAddress('ana@myexample.com')).toBe(false);
    expect(isReservedExampleAddress('ana@example.es')).toBe(false);
    expect(isReservedExampleAddress('')).toBe(false);
  });
});
