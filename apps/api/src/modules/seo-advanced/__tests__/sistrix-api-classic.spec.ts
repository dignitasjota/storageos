import { SistrixApiClient, apiCreditsToCount } from '../sistrix/sistrix-api.client';
import { normalizeSistrix, parseApiCredits, parseApiResponse } from '../sistrix/sistrix-normalizer';

/**
 * Respuestas FALSAS de la API clásica de SISTRIX con la forma que documenta
 * (`answer` + `credits[0].used`, o `error`). No se llama a SISTRIX: sirven para
 * comprobar cómo se leen los datos y se cuentan los créditos antes de la prueba
 * real con una consulta autorizada.
 */
const kwcount = (used?: number) => ({
  method: ['domain.kwcount.seo'],
  answer: [{ kwcount: [{ date: '2026-11-16T00:00:00+01:00', value: 412 }] }],
  ...(used === undefined ? {} : { credits: [{ used }] }),
});
const serp = (rows: number, used?: number) => ({
  method: ['keyword.seo'],
  answer: [
    {
      result: Array.from({ length: rows }, (_, i) => ({
        position: i + 1,
        domain: `web${i + 1}.es`,
        url: `https://web${i + 1}.es/trasteros`,
        title: `Trasteros ${i + 1}`,
      })),
    },
  ],
  ...(used === undefined ? {} : { credits: [{ used }] }),
});

function realClient(body: unknown): SistrixApiClient {
  const client = new SistrixApiClient({ get: () => 'real' } as never);
  (client as unknown as { simulated: boolean }).simulated = false;
  (client as unknown as { request: () => Promise<unknown> }).request = async () => body;
  return client;
}

describe('API clásica de SISTRIX: créditos', () => {
  it('lee los créditos que dice la respuesta', () => {
    const p = parseApiResponse(kwcount(1));
    expect(p.creditsKnown).toBe(true);
    expect(p.credits).toBe(1);
    expect(parseApiResponse(serp(10, 10)).credits).toBe(10);
  });

  it('sin bloque de créditos, se asume lo estimado (nunca 0)', async () => {
    const res = await realClient(serp(10)).call('k', 'keyword.seo', {
      kw: 'trasteros',
      country: 'es',
      num: '10',
    });
    expect(res.creditsKnown).toBe(false);
    expect(res.credits).toBe(10);
  });

  it('un «0 créditos» con datos no es creíble: se cuenta una por fila, como mucho lo pedido', async () => {
    const res = await realClient(serp(10, 0)).call('k', 'keyword.seo', {
      kw: 'trasteros',
      country: 'es',
      num: '10',
    });
    expect(res.creditsKnown).toBe(true);
    expect(res.credits).toBe(10);
    // Con menos filas de las pedidas, solo las que llegaron.
    const few = await realClient(serp(3, 0)).call('k', 'keyword.seo', {
      kw: 'trasteros',
      country: 'es',
      num: '10',
    });
    expect(few.credits).toBe(3);
  });

  it('un error o una respuesta vacía cuentan lo que digan (también 0)', () => {
    const err = parseApiResponse({ error: [{ code: 1000, error_message: 'sin resultados' }] });
    expect(apiCreditsToCount(err, 'keyword.seo', { num: '10' })).toBe(0);
    const empty = parseApiResponse({ error: [{ code: 7010, error_message: 'límite' }] });
    expect(apiCreditsToCount(empty, 'keyword.seo', { num: '10' })).toBe(0);
  });

  it('las métricas de una palabra son 5 créditos', async () => {
    const res = await realClient({
      answer: [{ result: [{ traffic: 100 }] }],
      credits: [{ used: 0 }],
    }).call('k', 'keyword.seo.metrics', { kw: 'a', country: 'es' });
    expect(res.credits).toBe(5);
  });
});

describe('API clásica de SISTRIX: forma de los datos', () => {
  it('los resultados de Google traen posición, dominio, URL y título', () => {
    const out = normalizeSistrix('serp', parseApiResponse(serp(3, 3)).payload);
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok' && out.data.op === 'serp') {
      expect(out.data.rows).toHaveLength(3);
      expect(out.data.rows[0]).toMatchObject({
        position: 1,
        domain: 'web1.es',
        title: 'Trasteros 1',
      });
    }
  });

  it('el número de palabras del dominio se lee', () => {
    const out = normalizeSistrix('kwcount', parseApiResponse(kwcount(1)).payload);
    expect(out.kind).toBe('ok');
  });

  it('el saldo del método `credits`', () => {
    expect(parseApiCredits({ answer: [{ credits: [{ value: 2450 }] }] })).toBe(2450);
    expect(parseApiCredits({ answer: [{ credits: [{ credits: 1200 }] }] })).toBe(1200);
    expect(parseApiCredits({})).toBeNull();
  });
});
