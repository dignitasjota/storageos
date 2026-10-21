import { describe, expect, it } from 'vitest';

import { adPerformanceRatios } from './index';

describe('adPerformanceRatios', () => {
  it('calcula CTR, coste por clic, por contacto y por reserva', () => {
    expect(
      adPerformanceRatios({
        impressions: 2000,
        clicks: 50,
        cost: 100,
        platformConversions: 6,
        contacts: 8,
        bookings: 2,
        signed: 1,
      }),
    ).toEqual({ ctr: 0.025, cpc: 2, costPerContact: 12.5, costPerBooking: 50 });
  });

  it('sin base no inventa cifras', () => {
    expect(
      adPerformanceRatios({
        impressions: 0,
        clicks: 0,
        cost: 0,
        platformConversions: 0,
        contacts: 3,
        bookings: 1,
        signed: 1,
      }),
    ).toEqual({ ctr: null, cpc: null, costPerContact: null, costPerBooking: null });
  });
});
