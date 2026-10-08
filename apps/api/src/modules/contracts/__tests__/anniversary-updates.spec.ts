import { anniversaryPrice, dueAnniversary } from '../anniversary-updates.service';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (x: Date | null) => (x ? x.toISOString().slice(0, 10) : null);

describe('actualización de renta por aniversario', () => {
  it('propone el aniversario desde 30 días antes hasta 60 días después', () => {
    expect(iso(dueAnniversary(d('2025-03-15'), null, d('2026-02-20')))).toBe('2026-03-15');
    expect(iso(dueAnniversary(d('2025-03-15'), null, d('2026-05-01')))).toBe('2026-03-15');
    expect(dueAnniversary(d('2025-03-15'), null, d('2026-01-10'))).toBeNull();
    expect(dueAnniversary(d('2025-03-15'), null, d('2026-06-01'))).toBeNull();
  });

  it('no propone el primer año ni un aniversario ya actualizado', () => {
    expect(dueAnniversary(d('2026-03-15'), null, d('2026-03-20'))).toBeNull();
    expect(dueAnniversary(d('2025-03-15'), d('2026-03-15'), d('2026-03-20'))).toBeNull();
    // El del año siguiente vuelve a proponerse.
    expect(iso(dueAnniversary(d('2025-03-15'), d('2026-03-15'), d('2027-03-01')))).toBe(
      '2027-03-15',
    );
  });

  it('el 29 de febrero cae el 28 los años no bisiestos', () => {
    expect(iso(dueAnniversary(d('2024-02-29'), null, d('2025-02-20')))).toBe('2025-02-28');
  });

  it('calcula la renta nueva en céntimos', () => {
    expect(anniversaryPrice(700, 3)).toBe(721);
    expect(anniversaryPrice(75, 2.5)).toBe(76.88);
    expect(anniversaryPrice(100, -1)).toBe(99);
  });
});
