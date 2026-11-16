import { serviceBaseFromTotal } from '../contracts.service';

describe('serviceBaseFromTotal (servicio pagado con la fianza, IVA incluido)', () => {
  it('saca la base al céntimo y el total coincide con lo retenido', () => {
    expect(serviceBaseFromTotal(60, 21)).toEqual({ base: 49.59, total: 60 });
    expect(serviceBaseFromTotal(50, 21)).toEqual({ base: 41.32, total: 50 });
    expect(serviceBaseFromTotal(121, 21)).toEqual({ base: 100, total: 121 });
  });

  it('nunca pasa de lo retenido (puede quedarse un céntimo por debajo)', () => {
    const r = serviceBaseFromTotal(10, 21);
    expect(r.total).toBeLessThanOrEqual(10);
    expect(r).toEqual({ base: 8.26, total: 9.99 });
    for (const t of [0.01, 1, 3.33, 19.99, 37.5, 99.99, 250]) {
      const x = serviceBaseFromTotal(t, 21);
      expect(x.total).toBeLessThanOrEqual(t);
      expect(t - x.total).toBeLessThan(0.02);
    }
  });
});
