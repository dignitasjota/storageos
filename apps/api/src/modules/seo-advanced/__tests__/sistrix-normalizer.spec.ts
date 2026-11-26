import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  type McpToolResult,
  type SistrixOp,
  normalizeSistrix,
  parseApiCredits,
  parseApiResponse,
  parseMcpResult,
  sistrixCallForbidden,
  sistrixQueryHash,
  toApiCall,
  toMcpCall,
} from '../sistrix/sistrix-normalizer';

/** Respuestas reales grabadas en la prueba de concepto (sin tokens). */
const DIR = join(__dirname, 'fixtures', 'sistrix-mcp');
interface Fixture {
  tool: string;
  args: Record<string, unknown>;
  result: McpToolResult;
}
const fixture = (name: string): Fixture =>
  JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8')) as Fixture;

/** Operación nuestra de una llamada grabada. */
function opOf(f: Fixture): SistrixOp {
  const view = String(f.args.view ?? '');
  if (f.tool === 'keyword_domain_seo') return 'domain_keywords';
  if (f.tool === 'links') return 'linktargets';
  if (f.tool === 'ai_check') return 'ai_overview';
  if (f.tool === 'keyword') return view === 'seo' ? 'serp' : (view as SistrixOp);
  return view as SistrixOp;
}

describe('Normalizador de SISTRIX con las respuestas reales', () => {
  const files = readdirSync(DIR).filter(
    (f) =>
      f.startsWith('domain') ||
      f.startsWith('keyword') ||
      f.startsWith('links') ||
      f.startsWith('ai_check'),
  );

  it('hay una respuesta grabada de cada herramienta usada', () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
  });

  it.each(files.filter((f) => !f.includes('keyword-traffic')))(
    '%s se normaliza sin error',
    (file) => {
      const f = fixture(file.replace(/\.json$/, ''));
      const outcome = normalizeSistrix(opOf(f), parseMcpResult(f.result));
      expect(['ok', 'empty']).toContain(outcome.kind);
    },
  );

  it('visibilidad: texto en alemán, valor como texto («"0"») y como número', () => {
    const text = normalizeSistrix(
      'visindex',
      parseMcpResult(fixture('domain-visindex-trasteros.pro').result),
    );
    expect(text).toMatchObject({
      kind: 'ok',
      data: { op: 'visindex', points: [{ domain: 'trasteros.pro', date: '2026-11-23', value: 0 }] },
      dataDate: '2026-11-23',
    });
    const hist = normalizeSistrix(
      'visindex',
      parseMcpResult(fixture('domain-visindex-bluespace.es-history').result),
    );
    expect(hist.kind).toBe('ok');
    if (hist.kind === 'ok' && hist.data.op === 'visindex') {
      expect(hist.data.points.map((p) => p.value)).toEqual([0.7578, 0.8194, 0.7619]);
      expect(hist.dataDate).toBe('2026-11-23');
    }
    const small = normalizeSistrix(
      'visindex',
      parseMcpResult(fixture('domain-visindex-trasterosalmirante.es').result),
    );
    expect(small.kind === 'ok' && small.data.op === 'visindex' && small.data.points[0]!.value).toBe(
      0.0001,
    );
  });

  it('sin structuredContent: lee el texto con JSON (competidores, SERP, oportunidades, enlaces)', () => {
    const comp = normalizeSistrix(
      'competitors',
      parseMcpResult(fixture('domain-competitors-trasterosalmirante.es').result),
    );
    expect(comp).toMatchObject({
      kind: 'ok',
      data: { domains: expect.arrayContaining(['idealista.com', 'bluespace.es']) },
    });
    const serp = normalizeSistrix(
      'serp',
      parseMcpResult(fixture('keyword-seo-trasteros_valencia').result),
    );
    expect(serp.kind === 'ok' && serp.data.op === 'serp' && serp.data.rows).toHaveLength(10);
    if (serp.kind === 'ok' && serp.data.op === 'serp') {
      expect(serp.data.rows[1]).toEqual({
        position: 2,
        domain: 'bluespace.es',
        url: 'https://www.bluespace.es/alquiler-trasteros/valencia',
      });
    }
    const opp = normalizeSistrix(
      'opportunities',
      parseMcpResult(fixture('domain-opportunities-bluespace.es').result),
    );
    expect(opp.kind === 'ok' && opp.data.op === 'opportunities' && opp.data.rows[0]).toEqual({
      keyword: 'storage',
      position: 12,
      url: 'https://www.bluespace.es/en/storage-facilities-rental/alicante',
      gain: 100,
      competition: 55,
      traffic: null,
    });
    const links = normalizeSistrix(
      'linktargets',
      parseMcpResult(fixture('links-linktargets-bluespace.es').result),
    );
    expect(links.kind === 'ok' && links.data.op === 'linktargets' && links.data.rows[0]).toEqual({
      url: 'http://www.bluespace.es/',
      links: 263,
      domains: 95,
      hosts: 119,
    });
    const dk = normalizeSistrix(
      'domain_keywords',
      parseMcpResult(fixture('keyword_domain_seo-trasterosalmirante.es').result),
    );
    expect(dk.kind === 'ok' && dk.data.op === 'domain_keywords' && dk.data.rows[0]).toMatchObject({
      keyword: 'trasteros valencia perez galdos',
      position: 1,
    });
  });

  it('métricas, intención y visibilidad en IA (structuredContent)', () => {
    const m = normalizeSistrix(
      'metrics',
      parseMcpResult(fixture('keyword-metrics-trasteros_valencia').result),
    );
    expect(m).toMatchObject({
      kind: 'ok',
      data: {
        metrics: {
          traffic: 300,
          clicks: 250,
          cpc: 3,
          competition: 35,
          mobileShare: 0.74,
          desktopShare: 0.26,
        },
      },
    });
    const i = normalizeSistrix(
      'searchintent',
      parseMcpResult(fixture('keyword-searchintent-trasteros_valencia').result),
    );
    expect(i).toMatchObject({
      kind: 'ok',
      data: { intent: { know: 0, do: 80, visit: 80, website: 20 } },
    });
    const ai = normalizeSistrix(
      'ai_overview',
      parseMcpResult(fixture('ai_check-overview-bluespace.es').result),
    );
    expect(ai).toMatchObject({
      kind: 'ok',
      data: {
        overview: {
          promptCount: 312,
          models: [
            { model: 'aio', promptCount: 225 },
            { model: 'ai_mode', promptCount: 85 },
            { model: 'chatgpt', promptCount: 2 },
          ],
        },
      },
    });
  });

  it('el error 1000 («no result») es vacío, no un fallo (llega como texto con isError: false)', () => {
    const f = fixture('domain-kwcount-guardalobox.es');
    expect(f.result.isError).toBe(false);
    expect(parseMcpResult(f.result)).toEqual({ kind: 'empty' });
    expect(normalizeSistrix('kwcount', parseMcpResult(f.result))).toEqual({ kind: 'empty' });
  });

  it('el 7010 es la cuota diaria agotada y otros códigos son errores de datos', () => {
    const quota = parseMcpResult({
      content: [{ type: 'text', text: 'SISTRIX API Error (7010): daily limit reached' }],
      isError: false,
    });
    expect(quota).toEqual({ kind: 'quota', message: 'daily limit reached' });
    const other = parseMcpResult({
      content: [{ type: 'text', text: 'SISTRIX API Error (2003): invalid domain' }],
      isError: false,
    });
    expect(other).toEqual({ kind: 'error', code: '2003', message: 'invalid domain' });
    expect(normalizeSistrix('serp', other)).toEqual(other);
  });

  it('traduce consultas al MCP (país explícito) y a la API clásica', () => {
    expect(
      toMcpCall({ op: 'visindex', domain: 'a.es', country: 'ES', history: true, limit: 8 }),
    ).toEqual({
      tool: 'domain',
      args: { domain: 'a.es', view: 'visindex', country: 'es', history: true, limit: 8 },
    });
    expect(toMcpCall({ op: 'serp', keyword: 'x', country: 'es', limit: 10 }).args).toMatchObject({
      view: 'seo',
      keyword: 'x',
      country: 'es',
    });
    expect(toApiCall({ op: 'metrics', keyword: 'x', country: 'es' })).toEqual({
      method: 'keyword.seo.metrics',
      params: { kw: 'x', country: 'es' },
    });
    expect(toApiCall({ op: 'ai_overview', domain: 'a.es', country: 'es' })).toBeNull();
    // La huella no depende del proveedor ni de mayúsculas del país.
    expect(sistrixQueryHash({ op: 'metrics', keyword: 'x', country: 'ES' })).toBe(
      sistrixQueryHash({ op: 'metrics', keyword: 'x', country: 'es' }),
    );
  });

  it('nunca se llaman Optimizer, AI Tracker ni la vista `list` de ai_topicresearch', () => {
    expect(sistrixCallForbidden('project', 'overview')).toBe(true);
    expect(sistrixCallForbidden('project_onpage', 'meta')).toBe(true);
    expect(sistrixCallForbidden('ai_tracker_overview')).toBe(true);
    expect(sistrixCallForbidden('ai_topicresearch', 'list')).toBe(true);
    expect(sistrixCallForbidden('ai_topicresearch', 'overview')).toBe(false);
    expect(sistrixCallForbidden('domain', 'visindex')).toBe(false);
  });

  it('respuesta de la API clásica: datos, créditos usados, errores y saldo', () => {
    const ok = parseApiResponse({
      method: [['domain.visibilityindex']],
      answer: [{ sichtbarkeitsindex: [{ domain: 'a.es', date: '2026-11-23', value: '1,5' }] }],
      credits: [{ used: 1 }],
    });
    expect(ok.credits).toBe(1);
    expect(normalizeSistrix('visindex', ok.payload)).toMatchObject({
      kind: 'ok',
      data: { points: [{ value: 1.5 }] },
    });
    expect(
      parseApiResponse({ error: [{ code: '1000', error_message: 'no result' }] }).payload,
    ).toEqual({ kind: 'empty' });
    expect(parseApiResponse({ error: [{ code: 7010, error_message: 'limit' }] }).payload).toEqual({
      kind: 'quota',
      message: 'limit',
    });
    expect(parseApiCredits({ answer: [{ credits: [{ value: '9500' }] }] })).toBe(9500);
  });
});
