import { describe, expect, it } from 'vitest';

import { SUSPENSION_WEB_OFFLINE_DAYS } from '../admin/suspension';

import {
  decideWebIndexing,
  legalDocRobots,
  todayWebIndexing,
  type WebIndexingInput,
  type WebIndexingStatus,
} from './indexing';
import { TENANT_LEGAL_DOCS } from './legal';

const base: WebIndexingInput = {
  webPublished: true,
  status: 'active',
  isDemo: false,
  suspendedDays: null,
  mode: 'auto',
};
const decide = (over: Partial<WebIndexingInput>) => decideWebIndexing({ ...base, ...over });
const STATUSES: WebIndexingStatus[] = ['trial', 'active', 'suspended', 'cancelled'];

describe('decideWebIndexing · modo automático', () => {
  it('negocio activo o en prueba, publicado y no demo: indexable y en el sitemap', () => {
    expect(decide({ status: 'active' })).toEqual({
      indexable: true,
      inSitemap: true,
      reason: 'live',
    });
    expect(decide({ status: 'trial' })).toMatchObject({ indexable: true, inSitemap: true });
  });

  it('la cuenta de demostración no se indexa', () => {
    expect(decide({ isDemo: true })).toMatchObject({ indexable: false, reason: 'demo' });
    expect(decide({ isDemo: true, status: 'trial' })).toMatchObject({ inSitemap: false });
  });

  it('una web sin publicar no se indexa', () => {
    expect(decide({ webPublished: false })).toEqual({
      indexable: false,
      inSitemap: false,
      reason: 'not_published',
    });
  });

  it('dado de baja: fuera del índice al instante', () => {
    expect(decide({ status: 'cancelled' })).toEqual({
      indexable: false,
      inSitemap: false,
      reason: 'cancelled',
    });
  });

  it('suspendido: la web sigue igual hasta 15 días (indexable, fuera del sitemap)', () => {
    expect(decide({ status: 'suspended', suspendedDays: 0 })).toEqual({
      indexable: true,
      inSitemap: false,
      reason: 'suspended_grace',
    });
    expect(
      decide({ status: 'suspended', suspendedDays: SUSPENSION_WEB_OFFLINE_DAYS - 1 }),
    ).toMatchObject({ indexable: true, reason: 'suspended_grace' });
  });

  it('suspendido 15 días o más: fuera del índice y del sitemap', () => {
    expect(decide({ status: 'suspended', suspendedDays: SUSPENSION_WEB_OFFLINE_DAYS })).toEqual({
      indexable: false,
      inSitemap: false,
      reason: 'suspended_offline',
    });
    expect(decide({ status: 'suspended', suspendedDays: 60 })).toMatchObject({
      indexable: false,
      inSitemap: false,
    });
  });
});

describe('decideWebIndexing · modo sí y no', () => {
  it('«on» fuerza indexable aunque sea demo, suspendido o dado de baja (si está publicada)', () => {
    expect(decide({ mode: 'on', isDemo: true })).toMatchObject({
      indexable: true,
      inSitemap: true,
    });
    expect(decide({ mode: 'on', status: 'cancelled' })).toMatchObject({ indexable: true });
    expect(decide({ mode: 'on', status: 'suspended', suspendedDays: 90 })).toMatchObject({
      indexable: true,
      inSitemap: true,
    });
  });

  it('«on» no indexa una web sin publicar', () => {
    expect(decide({ mode: 'on', webPublished: false })).toMatchObject({
      indexable: false,
      reason: 'not_published',
    });
  });

  it('«off» no indexa nunca, aunque esté activo y publicado', () => {
    expect(decide({ mode: 'off', status: 'active' })).toEqual({
      indexable: false,
      inSitemap: false,
      reason: 'off',
    });
    expect(decide({ mode: 'off', status: 'trial', isDemo: false })).toMatchObject({
      inSitemap: false,
    });
  });
});

describe('decideWebIndexing · no cambia el sitemap de hoy', () => {
  it('en automático, el sitemap coincide con el filtro de antes para cualquier combinación', () => {
    for (const status of STATUSES) {
      for (const isDemo of [true, false]) {
        for (const webPublished of [true, false]) {
          const today = todayWebIndexing({ webPublished, status, isDemo });
          // Un suspendido de menos de 15 días se trata como hoy: fuera del sitemap.
          const rule = decide({
            webPublished,
            status,
            isDemo,
            suspendedDays: status === 'suspended' ? 0 : null,
          });
          expect({ status, isDemo, webPublished, inSitemap: rule.inSitemap }).toEqual({
            status,
            isDemo,
            webPublished,
            inSitemap: today.inSitemap,
          });
        }
      }
    }
  });

  it('la página solo cambia de «indexable» en los casos previstos (baja, suspensión ≥15 d, sin publicar)', () => {
    const changed: string[] = [];
    for (const status of STATUSES) {
      for (const webPublished of [true, false]) {
        for (const suspendedDays of [null, 0, SUSPENSION_WEB_OFFLINE_DAYS]) {
          const today = todayWebIndexing({ webPublished, status, isDemo: false });
          const rule = decide({ webPublished, status, isDemo: false, suspendedDays });
          if (rule.indexable !== today.indexable) {
            changed.push(
              `${status}/${webPublished ? 'publicada' : 'sin publicar'}/${suspendedDays ?? '-'}`,
            );
          }
        }
      }
    }
    expect(changed.sort()).toEqual(
      [
        // Sin publicar: fuera del índice en cualquier estado.
        ...['trial', 'active', 'suspended', 'cancelled'].flatMap((s) =>
          ['-', '0', '15'].map((d) => `${s}/sin publicar/${d}`),
        ),
        // Publicadas: solo la baja y la suspensión de 15 días o más.
        ...['-', '0', '15'].map((d) => `cancelled/publicada/${d}`),
        'suspended/publicada/15',
      ].sort(),
    );
  });
});

describe('legalDocRobots · textos legales', () => {
  it('ningún texto legal del negocio se indexa, sea cual sea el modo', () => {
    expect(legalDocRobots()).toEqual({ index: false, follow: true });
    for (const doc of TENANT_LEGAL_DOCS) {
      for (const mode of ['auto', 'on', 'off'] as const) {
        // La página legal ignora la decisión: aunque la web sea «on», su texto no.
        const decision = decide({ mode });
        expect({ doc, mode, robots: legalDocRobots().index && decision.indexable }).toEqual({
          doc,
          mode,
          robots: false,
        });
      }
    }
  });
});
