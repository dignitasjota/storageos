import { createHmac } from 'node:crypto';

import { verifySvixSignature } from '../svix-signature';

const secretBytes = Buffer.from('clave-de-prueba-resend-123456');
const secret = `whsec_${secretBytes.toString('base64')}`;
const body = '{"type":"email.bounced","data":{"email_id":"abc"}}';
const now = 1_790_000_000;

function sign(id: string, ts: number, payload: string): string {
  return createHmac('sha256', secretBytes).update(`${id}.${ts}.${payload}`).digest('base64');
}

describe('verifySvixSignature', () => {
  it('acepta una firma v1 válida (también entre varias)', () => {
    const sig = sign('msg_1', now, body);
    expect(
      verifySvixSignature({
        secret,
        id: 'msg_1',
        timestamp: String(now),
        signature: `v1,${sig}`,
        body,
        nowSeconds: now,
      }),
    ).toBe(true);
    expect(
      verifySvixSignature({
        secret,
        id: 'msg_1',
        timestamp: String(now),
        signature: `v1,b3RyYQ== v1,${sig}`,
        body,
        nowSeconds: now,
      }),
    ).toBe(true);
  });

  it('rechaza cuerpo alterado, firma ajena, marca de tiempo vieja y cabeceras ausentes', () => {
    const sig = sign('msg_1', now, body);
    const base = {
      secret,
      id: 'msg_1',
      timestamp: String(now),
      signature: `v1,${sig}`,
      nowSeconds: now,
    };
    expect(verifySvixSignature({ ...base, body: body.replace('abc', 'xyz') })).toBe(false);
    expect(
      verifySvixSignature({ ...base, body, signature: `v1,${sign('msg_2', now, body)}` }),
    ).toBe(false);
    expect(verifySvixSignature({ ...base, body, nowSeconds: now + 3600 })).toBe(false);
    expect(verifySvixSignature({ ...base, body, signature: undefined })).toBe(false);
    expect(verifySvixSignature({ ...base, body, secret: '' })).toBe(false);
  });
});
