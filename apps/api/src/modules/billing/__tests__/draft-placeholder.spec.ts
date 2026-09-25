import { draftPlaceholderNumber } from '../invoices.service';

describe('draftPlaceholderNumber', () => {
  it('es único aunque se generen muchos en el mismo milisegundo', () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const numbers = new Set(Array.from({ length: 1000 }, () => draftPlaceholderNumber()));
    expect(numbers.size).toBe(1000);
    for (const n of numbers) expect(n).toMatch(/^DRAFT-[0-9a-z]+-[0-9a-f]{8}$/);
    jest.restoreAllMocks();
  });
});
