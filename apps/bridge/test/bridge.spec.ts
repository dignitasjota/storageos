import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { startBridge } from '../src/bridge';

import type { AddressInfo } from 'node:net';

/**
 * Integración del bridge SIN hardware: un `http.Server` simula un equipo Dahua
 * (handshake Digest + stream multipart con un evento + snapshot), y un
 * `forward` de test captura lo que el bridge reenviaría al webhook.
 */
describe('bridge (integración con equipo Dahua simulado)', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      // 1er request sin auth → 401 con challenge Digest.
      if (!req.headers.authorization) {
        res.writeHead(401, {
          'www-authenticate': 'Digest realm="Login to ASI", qop="auth", nonce="n1"',
        });
        res.end();
        return;
      }
      // 2º request (con Digest) → stream multipart con un evento + JPEG.
      const boundary = 'evtboundary';
      res.writeHead(200, { 'content-type': `multipart/x-mixed-replace; boundary=${boundary}` });
      const jpeg = Buffer.from([0xff, 0xd8, 0xaa, 0xbb]);
      const evt = 'Events[0].Code=AccessControl\r\nEvents[0].CardNo=12001';
      res.write(`--${boundary}\r\nContent-Type: text/plain\r\nContent-Length: ${evt.length}\r\n\r\n${evt}`);
      res.write(
        Buffer.concat([
          Buffer.from(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`),
          jpeg,
        ]),
      );
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('se suscribe con Digest, parsea el evento + snapshot y lo reenvía al webhook', async () => {
    const forwarded: { eventType: string; kind: string; hasImage: boolean; token: string }[] = [];
    const silent = { info: () => {}, warn: () => {}, error: () => {} } as unknown as Console;

    const { stop } = startBridge(
      {
        webhookUrl: 'http://unused.test',
        devices: [
          {
            name: 'ASI test',
            baseUrl: base,
            username: 'admin',
            password: 'pw',
            events: ['AccessControl'],
            kind: 'alarm',
            ingestToken: 'tok-123',
          },
        ],
      },
      async (device, block) => {
        forwarded.push({
          eventType: block.events[0]?.code ?? '',
          kind: device.kind ?? 'camera',
          hasImage: block.jpeg !== null,
          token: device.ingestToken,
        });
      },
      silent,
    );

    // Espera activa a que el bridge procese el stream (máx ~3s).
    for (let i = 0; i < 30 && forwarded.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    stop();

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      eventType: 'AccessControl',
      kind: 'alarm',
      hasImage: true,
      token: 'tok-123',
    });
  });

  // Silencia el warning de import no usado de crypto en algunos linters.
  it('md5 disponible (sanity)', () => {
    expect(createHash('md5').update('x').digest('hex')).toHaveLength(32);
  });
});
