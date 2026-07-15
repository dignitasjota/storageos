import { createServer, type Server } from 'node:http';

import {
  buildDigestAuthHeader,
  digestRequest,
  parseDigestChallenge,
} from '../digest-fetch';

import type { AddressInfo } from 'node:net';


describe('digest-fetch', () => {
  describe('parseDigestChallenge', () => {
    it('parsea realm/nonce/qop/opaque', () => {
      const c = parseDigestChallenge(
        'Digest realm="Login to test", qop="auth", nonce="abc123", opaque="op99"',
      );
      expect(c).toEqual({ realm: 'Login to test', nonce: 'abc123', qop: 'auth', opaque: 'op99' });
    });

    it('devuelve null si no es Digest o falta nonce', () => {
      expect(parseDigestChallenge('Basic realm="x"')).toBeNull();
      expect(parseDigestChallenge('Digest realm="x"')).toBeNull();
    });
  });

  describe('buildDigestAuthHeader (vector RFC 2617)', () => {
    // Vector clásico del RFC 2617 §3.5.
    it('calcula el response esperado con qop=auth', () => {
      const header = buildDigestAuthHeader({
        method: 'GET',
        uri: '/dir/index.html',
        username: 'Mufasa',
        password: 'Circle Of Life',
        challenge: {
          realm: 'testrealm@host.com',
          nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
          qop: 'auth',
          opaque: '5ccc069c403ebaf9f0171e9517f40e41',
        },
        cnonce: '0a4f113b',
        nc: '00000001',
      });
      expect(header).toContain('response="6629fae49393a05397450978507c4ef1"');
      expect(header).toContain('qop=auth');
      expect(header).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
    });
  });

  describe('digestRequest (handshake contra un servidor local)', () => {
    let server: Server;
    let base: string;

    beforeAll(async () => {
      server = createServer((req, res) => {
        const auth = req.headers.authorization;
        if (!auth) {
          res.writeHead(401, {
            'www-authenticate': 'Digest realm="test", qop="auth", nonce="srvnonce"',
          });
          res.end('unauthorized');
          return;
        }
        // 2º paso: comprobamos que llega un header Digest bien formado del user correcto.
        if (auth.startsWith('Digest ') && auth.includes('username="admin"')) {
          res.writeHead(200);
          res.end('OK');
          return;
        }
        res.writeHead(403);
        res.end('forbidden');
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('autentica en 2 pasos y devuelve ok', async () => {
      const res = await digestRequest({ url: `${base}/x`, username: 'admin', password: 'pw' });
      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
      expect(res.body).toBe('OK');
    });

    it('no lanza ante red caída → ok false, status 0', async () => {
      // Puerto 1: rechazo inmediato (no cuelga el test).
      const res = await digestRequest({
        url: 'http://127.0.0.1:1/x',
        username: 'admin',
        password: 'pw',
        timeoutMs: 500,
      });
      expect(res.ok).toBe(false);
      expect(res.status).toBe(0);
    });
  });
});
