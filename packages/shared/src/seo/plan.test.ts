import { describe, expect, it } from 'vitest';

import {
  CreateSeoSiteChangeSchema,
  SEO_GSC_FINAL_DELAY_DAYS,
  UpdateSeoTaskSchema,
  seoOverlappingChanges,
  seoPageMatchesKey,
  seoReorderColumn,
  seoScopesIntersect,
  seoSiteChangeRange,
  seoSiteChangeScope,
  seoSiteChangeVerdict,
  seoSiteChangeWindowState,
  seoTaskDueState,
  seoUrlKey,
} from './plan';

const totals = (clicks: number, impressions: number, position: number | null) => ({
  clicks,
  impressions,
  position,
  ctr: impressions > 0 ? clicks / impressions : null,
});

describe('ventanas antes y después', () => {
  it('son simétricas y el día del cambio no cuenta en ningún lado', () => {
    expect(seoSiteChangeRange('2026-03-10', 7)).toEqual({
      beforeFrom: '2026-03-03',
      beforeTo: '2026-03-09',
      afterFrom: '2026-03-11',
      afterTo: '2026-03-17',
    });
    const r = seoSiteChangeRange('2026-03-01', 28);
    expect(r.beforeTo).toBe('2026-02-28');
    expect(r.afterFrom).toBe('2026-03-02');
    expect(r.afterTo).toBe('2026-03-29');
  });

  const base = {
    changeDate: '2026-03-10',
    days: 7,
    firstDataDate: '2025-01-01',
    lastDataDate: '2026-03-30',
    daysWithDataBefore: 7,
    daysWithDataAfter: 7,
  };

  it('espera a que pase la ventana y el margen de Google', () => {
    // La ventana acaba el 17; con el margen, se compara el 20.
    expect(seoSiteChangeWindowState({ ...base, today: '2026-03-15' })).toEqual({
      status: 'waiting',
      availableOn: '2026-03-20',
      daysLeft: 5,
    });
    expect(seoSiteChangeWindowState({ ...base, today: '2026-03-19' }).daysLeft).toBe(1);
    expect(seoSiteChangeWindowState({ ...base, today: '2026-03-20' }).status).toBe('ready');
    expect(SEO_GSC_FINAL_DELAY_DAYS).toBe(3);
  });

  it('pasado el margen, sigue esperando si Google no ha dado el último día', () => {
    expect(
      seoSiteChangeWindowState({ ...base, today: '2026-03-25', lastDataDate: '2026-03-16' }),
    ).toEqual({ status: 'waiting', availableOn: '2026-03-20', daysLeft: null });
  });

  it('sin histórico antes del cambio o con días que faltan, no compara', () => {
    expect(
      seoSiteChangeWindowState({ ...base, today: '2026-04-01', firstDataDate: '2026-03-05' })
        .status,
    ).toBe('no_history');
    expect(
      seoSiteChangeWindowState({ ...base, today: '2026-04-01', daysWithDataAfter: 5 }).status,
    ).toBe('incomplete');
    // 28 días: con 26 de 28 (más del 90 %) vale; con 24, no.
    const w28 = { ...base, days: 28, lastDataDate: '2026-05-01', today: '2026-05-01' };
    expect(
      seoSiteChangeWindowState({ ...w28, daysWithDataBefore: 26, daysWithDataAfter: 28 }).status,
    ).toBe('ready');
    expect(
      seoSiteChangeWindowState({ ...w28, daysWithDataBefore: 24, daysWithDataAfter: 28 }).status,
    ).toBe('incomplete');
  });
});

describe('veredicto', () => {
  it('mejora y empeora con datos suficientes, sin hablar de causa', () => {
    const up = seoSiteChangeVerdict({ before: totals(20, 400, 9), after: totals(40, 600, 6) });
    expect(up.verdict).toBe('better');
    expect(up.text).toMatch(/^Coincide con una mejora/);
    expect(up.text).toContain('+100 % de clics');
    expect(up.text).toContain('3,0 puestos arriba');
    expect(up.text).not.toMatch(/gracias/i);

    const down = seoSiteChangeVerdict({ before: totals(40, 600, 6), after: totals(20, 500, 8) });
    expect(down.verdict).toBe('worse');
    expect(down.text).toMatch(/^Coincide con un empeoramiento/);
  });

  it('señales que se contradicen o pequeñas: sin cambio claro', () => {
    const r = seoSiteChangeVerdict({ before: totals(30, 500, 6), after: totals(31, 520, 6.2) });
    expect(r.verdict).toBe('flat');
    // Más clics pero bajando puestos: 2 − 1 = 1, sin cambio claro.
    expect(
      seoSiteChangeVerdict({ before: totals(20, 500, 5), after: totals(30, 500, 7) }).verdict,
    ).toBe('flat');
  });

  it('con pocas impresiones no concluye', () => {
    const r = seoSiteChangeVerdict({ before: totals(2, 30, 12), after: totals(9, 45, 7) });
    expect(r.verdict).toBe('insufficient');
    expect(r.text).toContain('cada lado');
    expect(
      seoSiteChangeVerdict({ before: totals(2, 30, 12), after: totals(9, 300, 7) }).text,
    ).toContain('uno de los lados');
    // El umbral se puede cambiar.
    expect(
      seoSiteChangeVerdict({
        before: totals(2, 30, 12),
        after: totals(9, 45, 7),
        minImpressions: 20,
      }).verdict,
    ).toBe('better');
  });

  it('una página que antes no salía o que deja de salir', () => {
    expect(
      seoSiteChangeVerdict({ before: totals(0, 0, null), after: totals(5, 200, 15) }).verdict,
    ).toBe('better');
    expect(
      seoSiteChangeVerdict({ before: totals(5, 200, 15), after: totals(0, 0, null) }).verdict,
    ).toBe('worse');
  });

  it('compara con el resto del sitio', () => {
    const season = seoSiteChangeVerdict({
      before: totals(20, 400, 9),
      after: totals(30, 600, 8),
      site: { before: totals(100, 5000, 10), after: totals(150, 7000, 10) },
    });
    expect(season.verdict).toBe('better');
    expect(season.contextNote).toMatch(/El resto del sitio subió parecido/);
    const own = seoSiteChangeVerdict({
      before: totals(20, 400, 9),
      after: totals(40, 600, 6),
      site: { before: totals(100, 5000, 10), after: totals(102, 5000, 10) },
    });
    expect(own.contextNote).toBe('El resto del sitio, en las mismas fechas: +2 % de clics.');
  });
});

describe('alcance y solapamiento', () => {
  it('normaliza URLs y palabras', () => {
    expect(
      seoSiteChangeScope({
        urls: ['http://www.Ejemplo.es/Precios/?utm_source=x', 'ejemplo.es/precios', '/blog/'],
        keywords: ['  Trasteros   Valencia ', 'trasteros valencia'],
      }),
    ).toEqual({ urlKeys: ['ejemplo.es/precios', '/blog'], keywords: ['trasteros valencia'] });
    expect(seoUrlKey('')).toBe('');
    expect(seoPageMatchesKey('https://www.ejemplo.es/blog/', '/blog')).toBe(true);
    expect(seoPageMatchesKey('https://otro.es/precios', 'ejemplo.es/precios')).toBe(false);
    expect(seoPageMatchesKey('https://ejemplo.es/precios?gclid=1', 'ejemplo.es/precios')).toBe(
      true,
    );
  });

  it('avisa de las actuaciones con alcance común dentro de las ventanas', () => {
    const target = {
      id: 'a',
      date: '2026-03-10',
      title: 'Título nuevo',
      domainId: 'd1',
      urlKeys: ['ejemplo.es/precios'],
      keywords: [],
    };
    const others = [
      { ...target, id: 'b', date: '2026-03-14', title: 'Más texto' },
      { ...target, id: 'c', date: '2026-05-01', title: 'Lejos' },
      { ...target, id: 'd', date: '2026-03-12', urlKeys: ['ejemplo.es/blog'], title: 'Otra URL' },
      { ...target, id: 'e', date: '2026-03-12', urlKeys: [], title: 'Todo el sitio' },
      { ...target, id: 'f', date: '2026-03-12', domainId: 'd2', title: 'Otro dominio' },
    ];
    expect(seoOverlappingChanges(target, others, 7).map((o) => o.id)).toEqual(['e', 'b']);
    expect(seoOverlappingChanges(target, others, 90).map((o) => o.id)).toEqual(['e', 'b', 'c']);
    expect(
      seoScopesIntersect(
        { urlKeys: [], keywords: ['a'] },
        { urlKeys: ['x.es/y'], keywords: ['a', 'b'] },
      ),
    ).toBe(true);
  });
});

describe('tareas', () => {
  it('vencimiento por fecha límite o de publicación', () => {
    const t = (
      status: 'todo' | 'done',
      dueDate: string | null,
      publishDate: string | null = null,
    ) => seoTaskDueState({ status, dueDate, publishDate }, '2026-03-10');
    expect(t('todo', '2026-03-09')).toBe('overdue');
    expect(t('todo', '2026-03-10')).toBe('today');
    expect(t('todo', '2026-03-13')).toBe('soon');
    expect(t('todo', '2026-03-20')).toBeNull();
    expect(t('todo', null, '2026-03-10')).toBe('today');
    expect(t('done', '2026-03-01')).toBeNull();
  });

  it('reordena una columna', () => {
    expect(seoReorderColumn(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(seoReorderColumn(['a', 'b', 'c'], 'a', 5)).toEqual(['b', 'c', 'a']);
    expect(seoReorderColumn(['a', 'b'], 'x', 1)).toEqual(['a', 'x', 'b']);
  });

  it('valida altas y cambios', () => {
    expect(
      CreateSeoSiteChangeSchema.safeParse({ date: '2026-03-10', type: 'content' }).success,
    ).toBe(false);
    expect(
      CreateSeoSiteChangeSchema.safeParse({
        date: '2026-03-10',
        time: '25:00',
        type: 'content',
        title: 'Texto',
      }).success,
    ).toBe(false);
    expect(UpdateSeoTaskSchema.safeParse({}).success).toBe(false);
    expect(UpdateSeoTaskSchema.safeParse({ status: 'review' }).success).toBe(true);
  });
});
