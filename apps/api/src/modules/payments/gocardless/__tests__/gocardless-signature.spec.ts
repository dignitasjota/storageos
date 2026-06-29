import { createHmac } from 'node:crypto';

import { verifyGoCardlessSignature } from '../gocardless-client';

describe('verifyGoCardlessSignature', () => {
  const secret = 'whsec_test_1234567890';
  const body = Buffer.from('{"events":[{"action":"created"}]}');
  const validSig = createHmac('sha256', secret).update(body).digest('hex');

  it('acepta una firma HMAC-SHA256 correcta', () => {
    expect(verifyGoCardlessSignature(body, validSig, secret)).toBe(true);
  });

  it('rechaza firma incorrecta, ausente o con otro secret', () => {
    expect(verifyGoCardlessSignature(body, 'deadbeef', secret)).toBe(false);
    expect(verifyGoCardlessSignature(body, undefined, secret)).toBe(false);
    expect(verifyGoCardlessSignature(body, validSig, 'otro-secret')).toBe(false);
  });
});
