import { formatDateLong, formatEur } from '../format';

describe('format', () => {
  it('importes en euros con coma decimal', () => {
    // Intl separa con espacio duro antes del símbolo.
    expect(formatEur(121).replace(/\s/g, ' ')).toBe('121,00 €');
    expect(formatEur('6.05').replace(/\s/g, ' ')).toBe('6,05 €');
    expect(formatEur(1234.5).replace(/\s/g, ' ')).toBe('1234,50 €');
  });

  it('fecha larga en la zona de Madrid', () => {
    // 23:30 UTC del 30-sep ya es 1-oct en Madrid.
    expect(formatDateLong(new Date('2026-09-30T23:30:00Z'))).toBe('1 de octubre de 2026');
  });
});
