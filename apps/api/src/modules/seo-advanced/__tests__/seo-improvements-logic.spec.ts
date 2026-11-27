import { proposalFromAudit } from '../improvements/seo-annotations.service';
import { buildMovers, moverWeight, type SerpRow } from '../improvements/seo-competition.logic';
import {
  parseCompetitorsCsv,
  parseDomainKeywordsCsv,
  parseSerpCsv,
  SistrixCsvError,
} from '../improvements/sistrix-csv.parser';

const row = (
  keywordId: string,
  rank: number,
  position: number,
  domain: string,
  url = `https://${domain}/`,
): SerpRow => ({
  keywordId,
  rank,
  sampleDate: rank === 1 ? '2026-11-24' : '2026-11-17',
  position,
  domain,
  url,
  title: null,
});

describe('competencia: quién sube y quién baja', () => {
  const domains = [
    { domain: 'guardalo.es', own: true, pathPrefix: null },
    { domain: 'rival.es', own: false, pathPrefix: null },
    { domain: 'directorio.es', own: false, pathPrefix: '/valencia/' },
  ];
  const keywords = new Map([
    ['k1', { keyword: 'trasteros valencia', group: 'Valencia' }],
    ['k2', { keyword: 'guardamuebles', group: null }],
  ]);

  it('compara las dos últimas muestras y cuenta entradas y salidas', () => {
    const r = buildMovers({
      domains,
      keywords,
      rows: [
        row('k1', 2, 8, 'guardalo.es'),
        row('k1', 1, 5, 'guardalo.es'),
        row('k1', 2, 3, 'rival.es'),
        row('k1', 1, 6, 'rival.es'),
        row('k1', 1, 12, 'directorio.es', 'https://directorio.es/valencia/centro'),
        // k2 solo tiene una muestra: no se compara.
        row('k2', 1, 4, 'guardalo.es'),
      ],
    });
    expect(r.withoutHistory).toBe(1);
    expect(r.from).toBe('2026-11-17');
    expect(r.to).toBe('2026-11-24');
    const mine = r.items.find((i) => i.domain === 'guardalo.es')!;
    expect(mine.diff).toBe(3);
    const rival = r.items.find((i) => i.domain === 'rival.es')!;
    expect(rival.diff).toBe(-3);
    // Entra en el directorio (antes no salía).
    const dir = r.items.find((i) => i.domain === 'directorio.es')!;
    expect(dir.previous).toBeNull();
    expect(dir.current).toBe(12);
    expect(moverWeight(dir)).toBe(20);
  });

  it('un competidor de un directorio solo cuenta lo que cuelga de su ruta', () => {
    const r = buildMovers({
      domains,
      keywords,
      rows: [
        row('k1', 2, 5, 'directorio.es', 'https://directorio.es/madrid/centro'),
        row('k1', 1, 4, 'directorio.es', 'https://directorio.es/madrid/centro'),
        row('k1', 2, 9, 'guardalo.es'),
        row('k1', 1, 9, 'guardalo.es'),
      ],
    });
    expect(r.items.some((i) => i.domain === 'directorio.es')).toBe(false);
  });
});

describe('anotaciones propuestas desde el registro de actividad', () => {
  const at = new Date('2026-11-20T09:30:00Z');
  it('el SEO de la web propone un cambio de título', () => {
    const p = proposalFromAudit({
      id: 'a1',
      action: 'tenant.web_settings.changed',
      occurredAt: at,
      entityId: null,
      changes: { webSeo: { homeTitle: 'Nuevo' } },
    });
    expect(p).toMatchObject({
      sourceRef: 'a1',
      type: 'title_meta',
      changeDate: '2026-11-20',
      changeTime: '10:30',
      urls: ['/'],
    });
  });
  it('una entrada publicada es una página nueva con su dirección', () => {
    const p = proposalFromAudit({
      id: 'a2',
      action: 'blog_post.published',
      occurredAt: at,
      entityId: 'x',
      changes: { title: 'Cómo elegir trastero', isPublished: true, slug: 'como-elegir' },
    });
    expect(p).toMatchObject({ type: 'new_page', urls: ['/blog/como-elegir'] });
  });
  it('un borrador creado, un cambio de plantilla de otro tipo o una acción ajena no proponen nada', () => {
    expect(
      proposalFromAudit({
        id: 'a3',
        action: 'blog_post.created',
        occurredAt: at,
        entityId: null,
        changes: { title: 'x', isPublished: false },
      }),
    ).toBeNull();
    expect(
      proposalFromAudit({
        id: 'a4',
        action: 'tenant.web_settings.changed',
        occurredAt: at,
        entityId: null,
        changes: { webSections: {} },
      }),
    ).toBeNull();
    expect(
      proposalFromAudit({
        id: 'a5',
        action: 'user.invited',
        occurredAt: at,
        entityId: null,
        changes: {},
      }),
    ).toBeNull();
  });
  it('un cambio de dirección es una redirección con las dos', () => {
    const p = proposalFromAudit({
      id: 'a6',
      action: 'area_page.slug_changed',
      occurredAt: at,
      entityId: null,
      changes: { name: 'Mislata', slug: { from: 'mislata', to: 'trasteros-mislata' } },
    });
    expect(p).toMatchObject({ type: 'redirect', urls: ['/mislata', '/trasteros-mislata'] });
  });
});

describe('CSV de SISTRIX', () => {
  it('palabras de un dominio: cabeceras en español o inglés, ; o ,, sin repetidos', () => {
    const r = parseDomainKeywordsCsv(
      '﻿Palabra clave;Posición;URL;Volumen\ntrasteros valencia;3;https://a.es/valencia;900\nTRASTEROS VALENCIA;4;https://a.es/;900\nguardamuebles;x;;10\nalquiler trastero;12;;50',
    );
    expect(r.rows.map((x) => x.keyword)).toEqual(['trasteros valencia', 'alquiler trastero']);
    expect(r.skipped).toBe(2);
    const en = parseDomainKeywordsCsv('Keyword,Position,URL\ntrastero,5,https://a.es/');
    expect(en.rows).toEqual([{ keyword: 'trastero', position: 5, url: 'https://a.es/' }]);
  });
  it('sin las columnas de la palabra y la posición, explica qué falta', () => {
    expect(() => parseDomainKeywordsCsv('Nombre;Otra\na;b')).toThrow(SistrixCsvError);
  });
  it('resultados de una búsqueda: dominio de la URL si no hay columna, título opcional', () => {
    const r = parseSerpCsv(
      'Position;URL;Title\n1;https://www.rival.es/valencia;Trasteros en Valencia\n2;https://otra.es/;\n200;https://x.es/;fuera',
    );
    expect(r.rows).toEqual([
      {
        position: 1,
        domain: 'rival.es',
        url: 'https://www.rival.es/valencia',
        title: 'Trasteros en Valencia',
      },
      { position: 2, domain: 'otra.es', url: 'https://otra.es/', title: null },
    ]);
    expect(r.skipped).toBe(1);
  });
  it('competidores: dominios válidos y sin repetir', () => {
    const r = parseCompetitorsCsv(
      'Domain;Competence\nwww.rival.es;0.8\nrival.es;0.7\nno es dominio;1',
    );
    expect(r.rows).toEqual([{ domain: 'rival.es' }]);
    expect(r.skipped).toBe(2);
  });
  it('un fichero con demasiadas filas se rechaza', () => {
    const big = `Keyword;Position\n${Array.from({ length: 20_001 }, (_, i) => `k${i};1`).join('\n')}`;
    expect(() => parseDomainKeywordsCsv(big)).toThrow(/más de/);
  });
});
