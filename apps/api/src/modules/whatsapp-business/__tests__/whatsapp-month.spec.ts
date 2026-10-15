import { customerWhatsappWhere } from '../../../common/whatsapp-anonymize';
import { currentMonth } from '../whatsapp-assistant.service';

describe('currentMonth (límite mensual en hora de Madrid)', () => {
  it('empieza a medianoche del día 1 en Madrid', () => {
    // Invierno (UTC+1): 1 de marzo a las 00:00 en Madrid = 28 feb 23:00 UTC.
    const march = currentMonth(new Date('2026-03-01T00:30:00+01:00'));
    expect(march.key).toBe('2026-03');
    expect(march.start.toISOString()).toBe('2026-02-28T23:00:00.000Z');
    // Verano (UTC+2): 1 de julio a las 00:00 en Madrid = 30 jun 22:00 UTC.
    const july = currentMonth(new Date('2026-07-15T12:00:00Z'));
    expect(july.start.toISOString()).toBe('2026-06-30T22:00:00.000Z');
  });
});

describe('customerWhatsappWhere', () => {
  it('compara el número completo, no solo las últimas cifras', () => {
    expect(customerWhatsappWhere('c1', '622 33 44 55')).toEqual({
      OR: [{ customerId: 'c1' }, { waId: { in: ['622334455', '34622334455'] } }],
    });
    expect(customerWhatsappWhere('c1', '+44 7700 900123')).toEqual({
      OR: [{ customerId: 'c1' }, { waId: { in: ['447700900123'] } }],
    });
    expect(customerWhatsappWhere('c1', null)).toEqual({ OR: [{ customerId: 'c1' }] });
  });
});
