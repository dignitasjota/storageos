import { isInternalWebRequest } from '../internal-request';

import type { ExecutionContext } from '@nestjs/common';

const ctx = (headers: Record<string, string>) =>
  ({
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  }) as unknown as ExecutionContext;

describe('isInternalWebRequest', () => {
  const token = 'x'.repeat(40);

  it('reconoce el token del web', () => {
    expect(isInternalWebRequest(ctx({ 'x-internal-token': token }), token)).toBe(true);
  });

  it('rechaza un token distinto, ausente o sin configurar', () => {
    expect(isInternalWebRequest(ctx({ 'x-internal-token': 'y'.repeat(40) }), token)).toBe(false);
    expect(isInternalWebRequest(ctx({ 'x-internal-token': 'corto' }), token)).toBe(false);
    expect(isInternalWebRequest(ctx({}), token)).toBe(false);
    expect(isInternalWebRequest(ctx({ 'x-internal-token': token }), undefined)).toBe(false);
  });
});
