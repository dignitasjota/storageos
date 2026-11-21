import { todayFingerprintOf, todayReappearReason } from '../today-fingerprint';

describe('huella de los avisos apartados de «Hoy»', () => {
  it('un ticket vuelve si el cliente escribe o sube la prioridad', () => {
    const saved = todayFingerprintOf('ticket', {
      lastTenantMessageAt: '2026-11-20T10:00:00.000Z',
      priority: 'normal',
    });
    const same = todayFingerprintOf('ticket', {
      lastTenantMessageAt: '2026-11-20T10:00:00.000Z',
      priority: 'normal',
    });
    expect(todayReappearReason('ticket', saved, same)).toBeNull();
    const wrote = todayFingerprintOf('ticket', {
      lastTenantMessageAt: '2026-11-21T09:00:00.000Z',
      priority: 'normal',
    });
    expect(todayReappearReason('ticket', saved, wrote)).toBe('El cliente ha vuelto a escribir');
    const urgent = todayFingerprintOf('ticket', {
      lastTenantMessageAt: '2026-11-20T10:00:00.000Z',
      priority: 'urgent',
    });
    expect(todayReappearReason('ticket', saved, urgent)).toBe('Ha subido de prioridad');
  });

  it('un impago vuelve solo si sube la deuda', () => {
    const saved = { owedAmount: 49, owedPeriods: 1 };
    expect(
      todayReappearReason('past_due', saved, todayFingerprintOf('past_due', { owedAmount: 49 })),
    ).toBeNull();
    expect(
      todayReappearReason(
        'past_due',
        saved,
        todayFingerprintOf('past_due', { owedAmount: 98, owedPeriods: 2 }),
      ),
    ).toBe('La deuda ha subido');
  });

  it('los recuentos vuelven al crecer; sin huella guardada, no', () => {
    expect(todayReappearReason('device', { count: 1 }, { count: 2 })).toBe(
      'Hay más dispositivos sin conexión',
    );
    expect(todayReappearReason('device', { count: 2 }, { count: 1 })).toBeNull();
    expect(todayReappearReason('device', null, { count: 5 })).toBeNull();
    expect(todayFingerprintOf('nps', { id: 'x' })).toBeNull();
    expect(todayReappearReason('nps', { a: 1 }, null)).toBeNull();
  });

  it('un certificado vuelve al caducar y una renovación al vencer', () => {
    const cert = todayFingerprintOf('certificate', { daysLeft: 10 });
    expect(todayReappearReason('certificate', cert, { expired: true })).toBe(
      'El certificado ha caducado',
    );
    const renewal = todayFingerprintOf('renewal', { daysLeft: 1 });
    expect(
      todayReappearReason('renewal', renewal, todayFingerprintOf('renewal', { daysLeft: -2 })),
    ).toBe('La renovación ya ha vencido');
  });
});
