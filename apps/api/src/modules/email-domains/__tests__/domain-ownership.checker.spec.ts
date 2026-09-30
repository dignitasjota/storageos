import { resolveTxt } from 'node:dns/promises';

import { DomainOwnershipChecker } from '../domain-ownership.checker';

jest.mock('node:dns/promises', () => ({ resolveTxt: jest.fn() }));
const resolveTxtMock = resolveTxt as jest.MockedFunction<typeof resolveTxt>;

describe('DomainOwnershipChecker', () => {
  const OLD_ENV = process.env.NODE_ENV;
  beforeAll(() => {
    process.env.NODE_ENV = 'development';
  });
  afterAll(() => {
    process.env.NODE_ENV = OLD_ENV;
  });

  it('acepta el TXT con el código del tenant (también troceado)', async () => {
    resolveTxtMock.mockResolvedValueOnce([['otra-cosa'], ['trasteros-verification=', 'abc123']]);
    await expect(new DomainOwnershipChecker().check('garcia.es', 'abc123')).resolves.toBe(true);
    expect(resolveTxtMock).toHaveBeenCalledWith('_trasteros.garcia.es');
  });

  it('rechaza el código de otro tenant o la ausencia del registro', async () => {
    resolveTxtMock.mockResolvedValueOnce([['trasteros-verification=otro']]);
    await expect(new DomainOwnershipChecker().check('garcia.es', 'abc123')).resolves.toBe(false);
    resolveTxtMock.mockRejectedValueOnce(
      Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }),
    );
    await expect(new DomainOwnershipChecker().check('garcia.es', 'abc123')).resolves.toBe(false);
  });
});
