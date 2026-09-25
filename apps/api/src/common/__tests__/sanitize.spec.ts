import {
  REDACTED,
  sanitizeHeaders,
  sanitizeQuery,
  sanitizeUrl,
  serializeRequestForLog,
} from '../logging/sanitize';

describe('sanitizeUrl', () => {
  it.each([
    [
      '/v1/access/verify?key=dk_abc123&device=HW-1&pin=482913',
      `/v1/access/verify?key=${REDACTED}&device=HW-1&pin=${REDACTED}`,
    ],
    ['/access/verify?qr=tok_xyz', `/access/verify?qr=${REDACTED}`],
    [
      '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=s3cr3t&hub.challenge=42',
      `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${REDACTED}&hub.challenge=42`,
    ],
    ['/v1/public/move-in/sign/abc.def123', `/v1/public/move-in/sign/${REDACTED}`],
    ['/public/reviews/Zx9_tok', `/public/reviews/${REDACTED}`],
    ['/v1/invitations/token/inv.secret/accept', `/v1/invitations/token/${REDACTED}/accept`],
    ['/v1/customers?search=ana&cursor=abc', '/v1/customers?search=ana&cursor=abc'],
    ['/health', '/health'],
  ])('%s', (input, expected) => {
    expect(sanitizeUrl(input)).toBe(expected);
  });

  it('respeta undefined', () => {
    expect(sanitizeUrl(undefined)).toBeUndefined();
  });
});

describe('sanitizeQuery / sanitizeHeaders', () => {
  it('enmascara solo las claves sensibles', () => {
    expect(sanitizeQuery({ key: 'x', PIN: '1234', device: 'd1' })).toEqual({
      key: REDACTED,
      PIN: REDACTED,
      device: 'd1',
    });
    expect(
      sanitizeHeaders({ 'x-device-key': 'k', 'X-Camera-Token': 't', 'user-agent': 'ua' }),
    ).toEqual({ 'x-device-key': REDACTED, 'X-Camera-Token': REDACTED, 'user-agent': 'ua' });
  });
});

describe('serializeRequestForLog', () => {
  it('sanea url/query/cabeceras y descarta params (la ruta troceada)', () => {
    const out = serializeRequestForLog({
      id: 1,
      method: 'GET',
      url: '/v1/access/verify?key=dk&pin=1111',
      query: { key: 'dk', pin: '1111' },
      params: { path: ['v1', 'access', 'verify'] },
      headers: { 'x-device-key': 'dk', host: 'api' },
    });
    expect(out).toEqual({
      id: 1,
      method: 'GET',
      url: `/v1/access/verify?key=${REDACTED}&pin=${REDACTED}`,
      query: { key: REDACTED, pin: REDACTED },
      headers: { 'x-device-key': REDACTED, host: 'api' },
    });
  });
});
