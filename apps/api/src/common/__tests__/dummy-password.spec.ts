import { verifyAgainstDummyHash } from '../security/dummy-password';

describe('verifyAgainstDummyHash', () => {
  it('siempre devuelve false (y reutiliza el hash ficticio entre llamadas)', async () => {
    await expect(verifyAgainstDummyHash('lo-que-sea')).resolves.toBe(false);
    await expect(verifyAgainstDummyHash('')).resolves.toBe(false);
  });
});
