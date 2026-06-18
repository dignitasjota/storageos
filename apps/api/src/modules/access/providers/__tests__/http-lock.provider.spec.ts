import { createHmac } from 'node:crypto';

import { HttpLockProvider } from '../http-lock.provider';

describe('HttpLockProvider', () => {
  const provider = new HttpLockProvider();
  const baseArgs = {
    tenantId: 't',
    deviceId: 'dev-1',
    controlUrl: 'https://controller.local/open',
    controlSecret: 'super-secret-key',
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sin controlUrl → dispatched false (no hace fetch)', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const res = await provider.open({ tenantId: 't', deviceId: 'd' });
    expect(res.dispatched).toBe(false);
    expect(res.message).toBe('device_sin_control_url');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POST firmado con HMAC válido y dispatched true en 2xx', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    jest.spyOn(global, 'fetch').mockImplementation((url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    const res = await provider.open(baseArgs);
    expect(res.dispatched).toBe(true);
    expect(capturedUrl).toBe(baseArgs.controlUrl);

    const headers = capturedInit?.headers as Record<string, string>;
    const sig = headers['x-storageos-signature'];
    expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    // La firma debe verificar contra HMAC(secret, "<ts>.<body>").
    const ts = sig.match(/t=(\d+),/)![1];
    const v1 = sig.match(/v1=([0-9a-f]{64})/)![1];
    const body = capturedInit?.body as string;
    const expected = createHmac('sha256', baseArgs.controlSecret)
      .update(`${ts}.${body}`)
      .digest('hex');
    expect(v1).toBe(expected);
    expect(JSON.parse(body)).toMatchObject({ command: 'open', deviceId: 'dev-1' });
  });

  it('respuesta no-2xx → dispatched false con http_<status>', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
    const res = await provider.open(baseArgs);
    expect(res.dispatched).toBe(false);
    expect(res.message).toBe('http_503');
  });

  it('error de red → dispatched false sin lanzar', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await provider.open(baseArgs);
    expect(res.dispatched).toBe(false);
    expect(res.message).toBe('http_error');
  });
});
