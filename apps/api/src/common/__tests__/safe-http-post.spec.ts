import {
  checkOutboundUrlShape,
  createSafeLookup,
  safePostJson,
  UnsafeDestinationError,
} from '../security/safe-http-post';

import type { LookupAddress } from 'node:dns';

function lookupWith(addresses: LookupAddress[], all = false) {
  const lookup = createSafeLookup(() => Promise.resolve(addresses));
  return new Promise<{ err: Error | null; address: unknown }>((resolve) =>
    lookup('hook.example.com', { all }, (err, address) => resolve({ err, address })),
  );
}

describe('checkOutboundUrlShape', () => {
  it.each([
    ['https://hooks.zapier.com/abc', true],
    ['http://93.184.216.34:8080/x', true],
    ['http://127.0.0.1/x', false],
    ['http://0177.0.0.1/x', false], // octal: WHATWG lo normaliza a 127.0.0.1
    ['http://2130706433/x', false], // decimal
    ['http://169.254.169.254/latest/meta-data', false],
    ['http://172.18.0.5:3100/', false],
    ['http://[::1]/', false],
    ['http://[::ffff:10.0.0.1]/', false],
    ['http://loki:3100/loki/api/v1/query', false], // contenedor Docker
    ['http://localhost/', false],
    ['http://printer.local/', false],
    ['http://user:pass@example.com/', false],
    ['ftp://example.com/', false],
    ['no es una url', false],
  ])('%s → %s', (url, ok) => {
    expect(checkOutboundUrlShape(url).ok).toBe(ok);
  });
});

describe('createSafeLookup (validación al conectar, anti DNS rebinding)', () => {
  it('deja pasar una IP pública', async () => {
    const r = await lookupWith([{ address: '93.184.216.34', family: 4 }]);
    expect(r.err).toBeNull();
    expect(r.address).toBe('93.184.216.34');
  });

  it('rechaza si el dominio resuelve a una IP privada', async () => {
    const r = await lookupWith([{ address: '172.18.0.5', family: 4 }]);
    expect(r.err).toBeInstanceOf(UnsafeDestinationError);
  });

  it('rechaza si CUALQUIERA de las IPs resueltas es privada', async () => {
    const r = await lookupWith(
      [
        { address: '93.184.216.34', family: 4 },
        { address: '::1', family: 6 },
      ],
      true,
    );
    expect(r.err).toBeInstanceOf(UnsafeDestinationError);
  });

  it('devuelve la lista completa con all:true (autoSelectFamily)', async () => {
    const addrs = [{ address: '93.184.216.34', family: 4 }];
    const r = await lookupWith(addrs, true);
    expect(r.address).toEqual(addrs);
  });
});

describe('safePostJson', () => {
  it('rechaza una IP interna sin abrir conexión', async () => {
    await expect(
      safePostJson({ url: 'http://127.0.0.1:9/x', headers: {}, body: '{}', timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(UnsafeDestinationError);
  });

  it('rechaza un dominio que resuelve a una IP privada (DNS rebinding)', async () => {
    await expect(
      safePostJson({
        url: 'http://rebind.example.com/x',
        headers: {},
        body: '{}',
        timeoutMs: 1000,
        resolve: () => Promise.resolve([{ address: '10.0.0.8', family: 4 }]),
      }),
    ).rejects.toBeInstanceOf(UnsafeDestinationError);
  });
});
