import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  type McpToolResult,
  normalizeAiPrompts,
  normalizeAiSources,
  normalizeSistrix,
  parseMcpResult,
  sistrixCallForbidden,
  sistrixQueryHash,
  toApiCall,
  toMcpCall,
} from '../sistrix/sistrix-normalizer';
import { stubMcpResult } from '../sistrix/sistrix-stub-data';
import { aiSubject } from '../sistrix/sistrix-sync.service';

const DIR = join(__dirname, 'fixtures', 'sistrix-mcp');
const realOverview = (
  JSON.parse(readFileSync(join(DIR, 'ai_check-overview-bluespace.es.json'), 'utf8')) as {
    result: McpToolResult;
  }
).result;

/** Respuesta del MCP con `structuredContent` (la forma de las vistas de `ai_check`). */
const structured = (value: unknown): McpToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  structuredContent: value,
  isError: false,
});
/** Y solo con texto (otras herramientas responden así). */
const text = (value: unknown): McpToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  isError: false,
});

describe('SISTRIX ai_check (PR 12): consultas', () => {
  it('cada vista va al MCP con España, la vista y el dominio o las marcas', () => {
    expect(toMcpCall({ op: 'ai_overview', country: 'ES', domain: 'bluespace.es' })).toEqual({
      tool: 'ai_check',
      args: { view: 'overview', domains: 'bluespace.es', country: 'es' },
    });
    expect(toMcpCall({ op: 'ai_prompts', country: 'es', brands: ['guárdalo'], limit: 50 })).toEqual(
      {
        tool: 'ai_check',
        args: { view: 'prompts', brands: ['guárdalo'], country: 'es', limit: 50 },
      },
    );
    expect(
      toMcpCall({
        op: 'ai_sources',
        country: 'es',
        domain: 'guardalobox.es',
        brands: ['guárdalo'],
        sourceType: 'url',
        limit: 50,
      }),
    ).toEqual({
      tool: 'ai_check',
      args: {
        view: 'sources',
        domains: 'guardalobox.es',
        brands: ['guárdalo'],
        country: 'es',
        source_type: 'url',
        limit: 50,
      },
    });
    expect(
      toMcpCall({ op: 'ai_competitors', country: 'es', domain: 'a.es', limit: 20 }).args,
    ).toEqual({ view: 'competitors', domains: 'a.es', country: 'es', limit: 20 });
    expect(toMcpCall({ op: 'ai_answers', country: 'es', prompt: 'mejores trasteros' })).toEqual({
      tool: 'ai_prompt_answers',
      args: { prompt: 'mejores trasteros', country: 'es' },
    });
  });

  it('nada de esto va por la API clásica, y ai_topicresearch «list» sigue prohibida', () => {
    for (const op of ['ai_overview', 'ai_prompts', 'ai_sources', 'ai_competitors'] as const) {
      expect(toApiCall({ op, country: 'es', domain: 'a.es' })).toBeNull();
    }
    expect(toApiCall({ op: 'ai_answers', country: 'es', prompt: 'x' })).toBeNull();
    expect(sistrixCallForbidden('ai_check', 'prompts')).toBe(false);
    expect(sistrixCallForbidden('ai_prompt_answers')).toBe(false);
    expect(sistrixCallForbidden('ai_topicresearch', 'list')).toBe(true);
    expect(sistrixCallForbidden('ai_tracker', 'overview')).toBe(true);
  });

  it('la huella de las consultas de antes no cambia (la caché sigue valiendo)', () => {
    const before = createHash('sha256')
      .update(
        JSON.stringify({
          op: 'ai_overview',
          country: 'es',
          domain: 'bluespace.es',
          keyword: null,
          limit: null,
          history: false,
        }),
      )
      .digest('hex');
    expect(sistrixQueryHash({ op: 'ai_overview', country: 'ES', domain: 'bluespace.es' })).toBe(
      before,
    );
    // Las marcas, en cualquier orden y mayúsculas, dan la misma huella.
    expect(sistrixQueryHash({ op: 'ai_prompts', country: 'es', brands: ['B', 'a'] })).toBe(
      sistrixQueryHash({ op: 'ai_prompts', country: 'es', brands: ['a', 'b'] }),
    );
  });

  it('a quién se refiere: el dominio o, sin él, las marcas juntas', () => {
    expect(aiSubject({ op: 'ai_overview', country: 'es', domain: 'A.es', brands: ['x'] })).toEqual({
      subjectType: 'domain',
      subject: 'a.es',
    });
    expect(aiSubject({ op: 'ai_overview', country: 'es', brands: ['Guárdalo', 'box'] })).toEqual({
      subjectType: 'brand',
      subject: 'box | guárdalo',
    });
  });
});

describe('SISTRIX ai_check (PR 12): respuestas', () => {
  it('el resumen real se sigue leyendo', () => {
    const out = normalizeSistrix('ai_overview', parseMcpResult(realOverview));
    expect(out).toMatchObject({ kind: 'ok', data: { overview: { promptCount: 312 } } });
  });

  it('prompts envueltos en grupos (como los modelos del resumen) o sueltos', () => {
    const grouped = structured({
      prompts: [
        {
          prompt: [
            { prompt: 'Mejores trasteros en Valencia', model: 'aio', answer: 'Texto <b>A</b>' },
            { prompt: 'trastero barato', model: 'aimode', response: 'Texto B', rank: '2' },
          ],
        },
      ],
    });
    const out = normalizeSistrix('ai_prompts', parseMcpResult(grouped));
    expect(out).toMatchObject({
      kind: 'ok',
      data: {
        op: 'ai_prompts',
        prompts: [
          { prompt: 'Mejores trasteros en Valencia', model: 'aio', answer: 'Texto <b>A</b>' },
          { prompt: 'trastero barato', model: 'ai_mode', answer: 'Texto B', rank: 2 },
        ],
      },
    });
    const flat = normalizeAiPrompts([{ query: 'guardamuebles', llm: 'ChatGPT', text: 'C' }]);
    expect(flat).toEqual([{ prompt: 'guardamuebles', model: 'chatgpt', answer: 'C', rank: null }]);
    // Sin prompt la fila no vale; vacío = sin resultados.
    expect(normalizeAiPrompts({ prompts: [{ model: 'aio' }] })).toEqual([]);
    expect(normalizeSistrix('ai_prompts', parseMcpResult(structured({ prompts: [] })))).toEqual({
      kind: 'empty',
    });
  });

  it('respuestas de un prompt seguido (`ai_prompt_answers`): se recortan', () => {
    const long = 'x'.repeat(5000);
    const out = normalizeSistrix(
      'ai_answers',
      parseMcpResult(structured({ answers: [{ prompt: 'p', model: 'chatgpt', answer: long }] })),
    );
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok' && out.data.op === 'ai_answers') {
      expect(out.data.prompts[0]!.answer).toHaveLength(4000);
    }
  });

  it('fuentes por URL o dominio y marcas que compiten, con su recuento como texto o número', () => {
    expect(
      normalizeAiSources(
        {
          sources: [
            { url: 'https://a.es/precios', prompt_count: '12' },
            { domain: 'b.es', count: 3 },
          ],
        },
        'source',
      ),
    ).toEqual([
      { source: 'https://a.es/precios', count: 12 },
      { source: 'b.es', count: 3 },
    ]);
    const brands = normalizeSistrix(
      'ai_competitors',
      parseMcpResult(text([{ brand: 'Bluespace', prompt_count: 40 }, { name: 'Lock & Go' }])),
    );
    expect(brands).toMatchObject({
      kind: 'ok',
      data: {
        sources: [
          { source: 'Bluespace', count: 40 },
          { source: 'Lock & Go', count: 0 },
        ],
      },
    });
  });

  it('el servidor simulado da prompts en los que sale la competencia y tú no', () => {
    const count = (domains: string) => {
      const out = normalizeSistrix(
        'ai_prompts',
        parseMcpResult(stubMcpResult('ai_check', { view: 'prompts', domains, limit: 50 })),
      );
      return out.kind === 'ok' && out.data.op === 'ai_prompts' ? out.data.prompts.length : 0;
    };
    expect(count('mio.es')).toBe(3);
    expect(count('competidor.es')).toBe(6);
  });
});
