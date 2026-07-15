import { createServer, type Server } from 'node:http';

import { DahuaLockProvider } from '../dahua-lock.provider';

import type { AddressInfo } from 'node:net';


describe('DahuaLockProvider', () => {
  const provider = new DahuaLockProvider();

  it('sin controlUrl → dispatched false', async () => {
    const res = await provider.open({ tenantId: 't', deviceId: 'd' });
    expect(res.dispatched).toBe(false);
    expect(res.message).toBe('device_sin_control_url');
  });

  it('sin credenciales user:pass → dispatched false', async () => {
    const res = await provider.open({
      tenantId: 't',
      deviceId: 'd',
      controlUrl: 'http://x.local',
      controlSecret: 'solo-secreto-sin-dos-puntos',
    });
    expect(res.dispatched).toBe(false);
    expect(res.message).toBe('device_sin_credenciales_digest');
  });

  describe('contra un terminal simulado (Digest + openDoor)', () => {
    let server: Server;
    let base: string;
    let lastUrl = '';

    beforeAll(async () => {
      server = createServer((req, res) => {
        lastUrl = req.url ?? '';
        if (!req.headers.authorization) {
          res.writeHead(401, {
            'www-authenticate': 'Digest realm="Login to ASI", qop="auth", nonce="n1"',
          });
          res.end();
          return;
        }
        // El terminal Dahua responde 'OK' al openDoor.
        res.writeHead(200);
        res.end('OK');
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('abre la puerta con accessControl.cgi?action=openDoor', async () => {
      const res = await provider.open({
        tenantId: 't',
        deviceId: 'd',
        controlUrl: base,
        controlSecret: 'admin:pw',
      });
      expect(res.dispatched).toBe(true);
      expect(lastUrl).toContain('/cgi-bin/accessControl.cgi');
      expect(lastUrl).toContain('action=openDoor');
      expect(lastUrl).toContain('channel=1');
    });
  });

  it('terminal inalcanzable → dispatched false (no lanza)', async () => {
    const res = await provider.open({
      tenantId: 't',
      deviceId: 'd',
      controlUrl: 'http://127.0.0.1:1',
      controlSecret: 'admin:pw',
    });
    expect(res.dispatched).toBe(false);
    expect(res.message).toContain('dahua_');
  });
});
