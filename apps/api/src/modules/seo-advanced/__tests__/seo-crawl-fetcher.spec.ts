import http from 'node:http';

import { SeoCrawlFetcher } from '../crawler/seo-crawl-fetcher';

import type { AddressInfo } from 'node:net';

/**
 * El GET seguro del rastreador contra un servidor local simulado: el host se
 * resuelve con un resolutor de pruebas (127.0.0.1 solo con `useTestRouting`,
 * que fuera de las pruebas no se puede usar) y se comprueban los topes y las
 * defensas frente a SSRF en cada salto.
 */
describe('SeoCrawlFetcher', () => {
  let server: http.Server;
  let port = 0;
  const fetcher = new SeoCrawlFetcher();
  const project = new Set(['ejemplo.es', 'www.ejemplo.es', 'interno.es', 'www.interno.es']);
  const allowHost = (h: string) => project.has(h);
  const opts = { allowHost, timeoutMs: 1500 };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      const path = req.url ?? '/';
      if (path === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<title>Hola ${host}</title>`);
        return;
      }
      if (path.startsWith('/salto/')) {
        const n = Number(path.slice('/salto/'.length));
        res.writeHead(301, { location: n > 1 ? `/salto/${n - 1}` : '/' });
        res.end();
        return;
      }
      const redirects: Record<string, string> = {
        '/fuera': 'https://otra-web.es/',
        '/metadatos': 'http://169.254.169.254/latest/meta-data',
        '/interna': 'https://interno.es/',
        '/www': 'https://www.ejemplo.es/',
      };
      if (redirects[path]) {
        res.writeHead(302, { location: redirects[path] });
        res.end();
        return;
      }
      if (path === '/grande') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('x'.repeat(5000));
        return;
      }
      if (path === '/grande-sin-longitud') {
        res.writeHead(200, { 'content-type': 'text/html', 'transfer-encoding': 'chunked' });
        let n = 0;
        const t = setInterval(() => {
          if (res.destroyed || ++n > 10) {
            clearInterval(t);
            if (!res.destroyed) res.end();
            return;
          }
          res.write('y'.repeat(1000));
        }, 5);
        t.unref();
        return;
      }
      if (path === '/lenta') {
        setTimeout(() => {
          if (!res.destroyed) {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end('tarde');
          }
        }, 3000).unref();
        return;
      }
      if (path === '/pdf') {
        res.writeHead(200, { 'content-type': 'application/pdf' });
        res.end('%PDF');
        return;
      }
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('no');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
    fetcher.useTestRouting({
      port,
      resolve: async (host) =>
        host === 'interno.es' || host === 'www.interno.es'
          ? [{ address: '10.0.0.7', family: 4 }]
          : [{ address: '127.0.0.1', family: 4 }],
    });
  });

  afterAll(async () => {
    fetcher.useTestRouting(null);
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('pide una página y lee el HTML', async () => {
    const r = await fetcher.fetch('https://ejemplo.es/', opts);
    expect(r).toMatchObject({ status: 200, finalStatus: 200, error: null, chain: [] });
    expect(r.body).toBe('<title>Hola ejemplo.es</title>');
    expect(r.contentType).toContain('text/html');
  });

  it('sigue las redirecciones a mano, con tope de 5', async () => {
    const ok = await fetcher.fetch('https://ejemplo.es/salto/3', opts);
    expect(ok).toMatchObject({ status: 301, finalStatus: 200, error: null });
    expect(ok.chain).toEqual([
      'https://ejemplo.es/salto/2',
      'https://ejemplo.es/salto/1',
      'https://ejemplo.es/',
    ]);
    const tooMany = await fetcher.fetch('https://ejemplo.es/salto/8', opts);
    expect(tooMany.error).toBe('too_many_redirects');
    expect(tooMany.chain).toHaveLength(6);
  });

  it('no sigue una redirección a un dominio que no es del proyecto', async () => {
    const r = await fetcher.fetch('https://ejemplo.es/fuera', opts);
    expect(r).toMatchObject({
      status: 302,
      finalStatus: null,
      externalRedirect: true,
      finalUrl: 'https://otra-web.es/',
      error: null,
    });
  });

  it('bloquea una redirección a una IP interna (literal o resuelta)', async () => {
    const meta = await fetcher.fetch('https://ejemplo.es/metadatos', opts);
    expect(meta.error).toBe('unsafe:private_ip');
    // Un dominio del proyecto que resuelve a una IP privada: se corta al conectar.
    const internal = await fetcher.fetch('https://ejemplo.es/interna', opts);
    expect(internal.status).toBe(302);
    expect(internal.error).toBe('unsafe:private_ip');
    const www = await fetcher.fetch('https://ejemplo.es/www', opts);
    expect(www).toMatchObject({ finalStatus: 200, error: null });
  });

  it('solo pide hosts del proyecto', async () => {
    const r = await fetcher.fetch('https://otra-web.es/', opts);
    expect(r.error).toBe('host_not_allowed');
    expect(r.status).toBeNull();
  });

  it('corta la descarga al pasar del tamaño máximo (con y sin longitud declarada)', async () => {
    const a = await fetcher.fetch('https://ejemplo.es/grande', { ...opts, maxBytes: 1000 });
    expect(a.error).toBe('too_large');
    const b = await fetcher.fetch('https://ejemplo.es/grande-sin-longitud', {
      ...opts,
      maxBytes: 2500,
    });
    expect(b.error).toBe('too_large');
  });

  it('corta una petición que tarda más del tiempo máximo', async () => {
    const r = await fetcher.fetch('https://ejemplo.es/lenta', { ...opts, timeoutMs: 300 });
    expect(r.error).toBe('timeout');
  });

  it('no lee el cuerpo de lo que no es HTML ni texto', async () => {
    const r = await fetcher.fetch('https://ejemplo.es/pdf', opts);
    expect(r).toMatchObject({ status: 200, body: null, error: null });
  });

  it('sin el enrutado de pruebas, nada interno pasa', async () => {
    const plain = new SeoCrawlFetcher();
    const loopback = await plain.fetch(`http://127.0.0.1:${port}/`, {
      allowHost: () => true,
      timeoutMs: 1000,
    });
    expect(loopback.error).toBe('unsafe:private_ip');
    const rebinding = await plain.fetch('https://ejemplo.es/', {
      allowHost,
      timeoutMs: 1000,
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    expect(rebinding.error).toBe('unsafe:private_ip');
    const internalName = await plain.fetch('http://loki:3100/', {
      allowHost: () => true,
      timeoutMs: 1000,
    });
    expect(internalName.error).toBe('unsafe:internal_hostname');
  });

  it('el enrutado de pruebas no se puede usar fuera de las pruebas', () => {
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() =>
        new SeoCrawlFetcher().useTestRouting({ port: 1, resolve: async () => [] }),
      ).toThrow();
    } finally {
      process.env.NODE_ENV = env;
    }
  });
});
