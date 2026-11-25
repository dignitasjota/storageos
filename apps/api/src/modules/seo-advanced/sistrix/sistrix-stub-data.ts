import { createHash } from 'node:crypto';

import type { McpToolResult } from './sistrix-normalizer';

/**
 * Respuestas simuladas de SISTRIX (modo `stub` y tests), copiadas de las que
 * dio el servidor real en la prueba de concepto: mismos formatos (texto con
 * JSON o `structuredContent`), números como texto, nombres en alemán y errores
 * como texto con `isError: false`. Deterministas por dominio o palabra.
 *
 * Disparadores para las pruebas: un dominio o palabra que contenga `noresult`
 * da el error 1000 (sin resultados) y uno que contenga `quota7010`, el 7010.
 */

const seed = (s: string) => parseInt(createHash('sha256').update(s).digest('hex').slice(0, 8), 16);

const text = (value: unknown): McpToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  isError: false,
});
const structured = (value: unknown): McpToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  structuredContent: value,
  isError: false,
});
export const stubSistrixError = (code: string, message: string): McpToolResult => ({
  content: [{ type: 'text', text: `SISTRIX API Error (${code}): ${message}` }],
  isError: false,
});

/** Lunes de las últimas `n` semanas (la visibilidad es semanal, de lunes). */
function mondays(n: number): string[] {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 7);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 7);
  }
  return out;
}

/** Dominios de la prueba que dieron visibilidad 0 (pequeños para su muestra). */
const ZERO_DOMAINS = new Set(['guardalobox.es', 'trasteros.pro']);

function visindex(domain: string, history: boolean, limit: number): McpToolResult {
  const dates = mondays(history ? Math.max(1, Math.min(limit, 52)) : 1);
  const base = ZERO_DOMAINS.has(domain) ? 0 : (seed(domain) % 9000) / 10000 + 0.0001;
  const rows = dates.map((date, i) => ({
    domain,
    date,
    // Sin histórico el valor llega como texto, con histórico como número.
    value: history ? Math.round(base * (1 - i * 0.02) * 10000) / 10000 : String(base),
  }));
  return structured({ sichtbarkeitsindex: rows });
}

const COMPETITORS = [
  'idealista.com',
  'fotocasa.es',
  'callejero.net',
  'bluespace.es',
  'milanuncios.com',
  'fierostorage.com',
  'yaencontre.com',
  'instagram.com',
];

const SERP = [
  ['idealista.com', 'https://www.idealista.com/alquiler-trasteros/valencia-valencia/'],
  ['bluespace.es', 'https://www.bluespace.es/alquiler-trasteros/valencia'],
  ['trasteroom.es', 'https://trasteroom.es/'],
  ['flexcube.es', 'https://flexcube.es/'],
  ['storabble.com', 'https://storabble.com/es-es/trasteros/valencia'],
  [
    'contenedorestrasteros.com',
    'https://contenedorestrasteros.com/es/blog/cuanto-cuesta-alquilar-un-trastero/',
  ],
  ['wallapop.com', 'https://es.wallapop.com/inmobiliaria/trasteros/valencia'],
  ['box2boxstorage.com', 'https://www.box2boxstorage.com/es/trasteros/valencia'],
  ['yaencontre.com', 'https://www.yaencontre.com/alquiler/trasteros/valencia-valencia-provincia'],
  ['mundoespacios.es', 'https://mundoespacios.es/valencia/almacenaje/trasteros/'],
] as const;

const DOMAIN_KEYWORDS = [
  ['trasteros valencia perez galdos', 1, '/avda-perez-galdos-95-99/'],
  ['trasteros urbanos valencia', 2, '/'],
  ['urban trasteros valencia', 2, '/'],
  ['inmobiliaria almirante', 3, '/'],
  ['gran via fernando el catolico 70', 3, '/granvia-fernando-el-catolico-70/'],
  ['trasteros monteolivete', 3, '/luis-oliag-59/'],
  ['trasteros valencia 46022', 3, '/marino-albesa-5/'],
  ['trasteros burjassot', 4, '/joaquin-navarro-16/'],
  ['trasteros alquiler patraix valencia', 4, '/salabert-3/'],
  ['alquiler trasteros monteolivete', 4, '/luis-oliag-59/'],
] as const;

const OPPORTUNITIES = [
  ['storage', 100, 12, 55],
  ['trasteros baratos', 66, 11, 37],
  ['guardamuebles', 66, 11, 22],
  ['mudanza', 66, 11, 37],
  ['alquiler trastero mensual', 66, 11, 22],
] as const;

/** Respuesta simulada de una herramienta del MCP. */
export function stubMcpResult(tool: string, args: Record<string, unknown>): McpToolResult {
  const domain = String(args.domain ?? args.domains ?? '').toLowerCase();
  const keyword = String(args.keyword ?? args.kw ?? '').toLowerCase();
  const subject = domain || keyword;
  if (subject.includes('quota7010')) {
    return stubSistrixError('7010', 'daily request limit reached');
  }
  if (subject.includes('noresult')) return stubSistrixError('1000', 'no result');
  const view = String(args.view ?? '');
  const limit = typeof args.limit === 'number' ? args.limit : 10;

  if (tool === 'domain') {
    switch (view) {
      case 'visindex':
        return visindex(domain, args.history === true, limit);
      case 'kwcount':
        if (ZERO_DOMAINS.has(domain)) return stubSistrixError('1000', 'no result');
        return structured({
          kwcount: [{ domain, date: mondays(1)[0], value: String(50 + (seed(domain) % 900)) }],
        });
      case 'competitors':
        return text(COMPETITORS.filter((c) => c !== domain).slice(0, limit));
      case 'opportunities':
      case 'ideas':
        return text(
          OPPORTUNITIES.slice(0, limit).map(([kw, gain, position, competition]) => ({
            domain,
            gain,
            keyword: view === 'ideas' ? `${kw} ${domain.split('.')[0]}` : kw,
            position,
            url: `https://www.${domain}/${String(kw).replace(/\s+/g, '-')}`,
            competition,
          })),
        );
      default:
        return stubSistrixError('1000', 'no result');
    }
  }
  if (tool === 'keyword_domain_seo') {
    return text(
      DOMAIN_KEYWORDS.slice(0, limit).map(([kw, position, path]) => ({
        keyword: kw,
        position,
        url: `https://${domain}${path}`,
      })),
    );
  }
  if (tool === 'keyword') {
    const s = seed(keyword);
    switch (view) {
      case 'seo':
        return text(
          SERP.slice(0, limit).map(([d, url], i) => ({ domain: d, position: i + 1, url })),
        );
      case 'metrics':
        return structured({
          result: [
            {
              kw: keyword,
              competition: 20 + (s % 60),
              cpc: 1 + (s % 4),
              traffic: 100 + (s % 900),
              clicks: 80 + (s % 700),
              desktop_distribution: 0.26,
              mobile_distribution: 0.74,
            },
          ],
        });
      case 'traffic':
        return structured({
          result: [
            {
              kw: keyword,
              traffic: 100 + (s % 900),
              clicks: 80 + (s % 700),
              country: args.country,
            },
          ],
        });
      case 'searchintent':
        return structured({
          result: [{ intent_website: 20, intent_know: 0, intent_visit: 80, intent_do: 80 }],
        });
      default:
        return stubSistrixError('1000', 'no result');
    }
  }
  if (tool === 'links' && view === 'linktargets') {
    return text(
      [
        { url: `http://www.${domain}/`, links: 263, domains: 95, hosts: 119, nets: 53, ips: 57 },
        { url: `https://${domain}/`, links: 230, domains: 133, hosts: 135, nets: 37, ips: 37 },
        { url: `https://www.${domain}/`, links: 127, domains: 61, hosts: 64, nets: 50, ips: 50 },
      ].slice(0, limit),
    );
  }
  if (tool === 'ai_check' && view === 'overview') {
    return structured({
      counts: [{ prompt_count: 312 }],
      models: [
        {
          model: [
            { model: 'aio', prompt_count: 225 },
            { model: 'ai_mode', prompt_count: 85 },
            { model: 'chatgpt', prompt_count: 2 },
          ],
        },
      ],
      countries: [{ country: [{ country: 'es', prompt_count: 312 }] }],
    });
  }
  return stubSistrixError('1000', 'no result');
}

/** Catálogo de herramientas simulado (el real, recortado a lo que usamos). */
export function stubMcpTools(variant: 'default' | 'changed'): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}[] {
  const tool = (name: string, views: string[] | null, description: string) => ({
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: {
        ...(views ? { view: { type: 'string', enum: views } } : {}),
        country: { type: 'string', default: 'de' },
      },
    },
  });
  const domainViews = [
    'visindex',
    'visindex_overview',
    'kwcount',
    'kwcount_top10',
    'urlcount',
    'competitors',
    'ideas',
    'opportunities',
    'ranking_distribution',
    'traffic_estimation',
    'hosts',
    'paths',
  ];
  const tools = [
    tool(
      'domain',
      variant === 'changed' ? domainViews.filter((v) => v !== 'opportunities') : domainViews,
      'SISTRIX domain analytics.',
    ),
    tool(
      'keyword',
      [
        'seo',
        'metrics',
        'traffic',
        'competition',
        'searchintent',
        'serpfeatures',
        'traffic_estimation',
        'questions',
      ],
      'SISTRIX keyword analytics.',
    ),
    tool('keyword_domain_seo', null, 'All organic Google keywords the given domain ranks for.'),
    tool('links', ['list', 'linktexts', 'linktargets'], 'SISTRIX backlink analytics for a domain.'),
    tool(
      'project',
      ['overview', 'competitors', 'ranking', 'visibilityindex', 'keyword_serps', 'external_links'],
      'SISTRIX Optimizer project analytics.',
    ),
    tool(
      'ai_check',
      ['overview', 'competitors', 'prompts', 'prompts_count', 'sources'],
      'SISTRIX AI Check.',
    ),
    tool('ai_topicresearch', ['overview', 'list', 'topic'], 'SISTRIX AI Topic Research.'),
  ];
  if (variant === 'changed') {
    tools.push(tool('domain_history', ['visindex'], 'Nueva herramienta de prueba.'));
  }
  return tools;
}
