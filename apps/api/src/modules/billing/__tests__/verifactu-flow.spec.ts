import {
  MAX_RECORDS_PER_SUBMISSION,
  parseWaitSeconds,
  retryDelayMs,
  sendableAt,
  sendJobId,
} from '../verifactu-flow';

describe('control de flujo de los envíos a la AEAT', () => {
  it('tras un fallo se espera 1, 2, 4… minutos y como mucho una hora', () => {
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(2)).toBe(120_000);
    expect(retryDelayMs(3)).toBe(240_000);
    expect(retryDelayMs(7)).toBe(3_600_000);
    expect(retryDelayMs(40)).toBe(3_600_000);
    expect(retryDelayMs(0)).toBe(60_000);
  });

  it('la espera de la AEAT: de 0 a 9999 segundos; sin dato válido, 60', () => {
    expect(parseWaitSeconds('0')).toBe(0);
    expect(parseWaitSeconds(' 120 ')).toBe(120);
    expect(parseWaitSeconds(null)).toBe(60);
    expect(parseWaitSeconds('-5')).toBe(60);
    expect(parseWaitSeconds('12345')).toBe(60);
  });

  it('con 1.000 registros acumulados no se espera a la AEAT, pero sí al reintento', () => {
    const nextSendAt = new Date('2026-11-08T10:01:00Z');
    const retryAt = new Date('2026-11-08T10:05:00Z');
    expect(sendableAt({ nextSendAt, retryAt: null }, 10)).toEqual(nextSendAt);
    expect(sendableAt({ nextSendAt, retryAt: null }, MAX_RECORDS_PER_SUBMISSION)).toBeNull();
    expect(sendableAt({ nextSendAt, retryAt }, MAX_RECORDS_PER_SUBMISSION)).toEqual(retryAt);
    expect(sendableAt({ nextSendAt, retryAt }, 1)).toEqual(retryAt);
    expect(sendableAt({ nextSendAt: null, retryAt: null }, 1)).toBeNull();
  });

  it('un trabajo por emisor y hora de salida', () => {
    const at = new Date('2026-11-08T10:00:00.000Z');
    expect(sendJobId('t1', null, at)).toBe(`vf-t1-self-${at.getTime()}`);
    expect(sendJobId('t1', 'o1', at)).toBe(`vf-t1-o1-${at.getTime()}`);
  });
});
