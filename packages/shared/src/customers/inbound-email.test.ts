import { describe, expect, it } from 'vitest';

import { isInboundEmailSenderVerified } from './schemas';

describe('isInboundEmailSenderVerified', () => {
  it.each([
    [{ dmarc: 'pass' }, true],
    [{ dmarc: 'PASS ' }, true],
    [{ dmarc: 'fail' }, false],
    [{ dmarc: 'none' }, false],
    [{ authenticationResults: 'mx.x; spf=pass; dkim=pass; dmarc=pass (p=reject)' }, true],
    [{ authenticationResults: 'mx.x; spf=pass; dkim=pass; dmarc=fail' }, false],
    // DKIM/SPF sueltos no bastan: pueden pasar para un dominio ajeno al From.
    [{ authenticationResults: 'mx.x; spf=pass; dkim=pass' }, false],
    [{}, false],
  ])('%j → %s', (input, expected) => {
    expect(isInboundEmailSenderVerified(input)).toBe(expected);
  });
});
