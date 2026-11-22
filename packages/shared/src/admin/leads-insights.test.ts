import { describe, expect, it } from 'vitest';

import {
  DiscardPlatformLeadSchema,
  PlatformLeadSequenceStepSchema,
  renderPlatformLeadTemplate,
} from './leads';
import {
  estimatePlatformLeadValue,
  findTaxId,
  isBusinessTime,
  parseLeadCount,
  responseDeadline,
  scorePlatformLead,
  similarCompanyNames,
  staleDaysOf,
  type PlatformLeadValueContext,
} from './leads-insights';

const NOW = new Date('2026-11-18T10:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe('parseLeadCount', () => {
  it('saca el número (el mayor si hay varios) y entiende los miles con punto', () => {
    expect(parseLeadCount('150')).toBe(150);
    expect(parseLeadCount('unos 200 trasteros')).toBe(200);
    expect(parseLeadCount('entre 50 y 80')).toBe(80);
    expect(parseLeadCount('1.200')).toBe(1200);
    expect(parseLeadCount('muchos')).toBeNull();
    expect(parseLeadCount(null)).toBeNull();
  });
});

describe('puntuación del lead', () => {
  const base = {
    status: 'new' as const,
    source: 'web_contact',
    units: null,
    facilities: null,
    replied: false,
    proposalOpens: 0,
    lastActivityAt: null,
    lastOutboundAt: null,
    lastInboundAt: null,
    createdAt: daysAgo(0),
  };

  it('cliente 100 y perdido 0', () => {
    expect(scorePlatformLead({ ...base, status: 'customer' }, NOW).score).toBe(100);
    expect(scorePlatformLead({ ...base, status: 'lost' }, NOW).score).toBe(0);
  });

  it('suma tamaño, origen, respuesta, propuesta abierta y actividad reciente, con sus motivos', () => {
    const hot = scorePlatformLead(
      {
        ...base,
        status: 'interested',
        source: 'demo',
        units: '250',
        facilities: '3',
        replied: true,
        proposalOpens: 3,
        lastActivityAt: daysAgo(1),
      },
      NOW,
    );
    // 20 (250 trasteros) + 8 (3 locales) + 15 (demo) + 15 (respondió) + 15 (propuesta ×3)
    // + 8 (interesado) + 10 (reciente) = 91
    expect(hot.score).toBe(91);
    expect(hot.factors.map((f) => f.key)).toEqual([
      'units',
      'facilities',
      'source',
      'replied',
      'proposal',
      'stage',
      'recent',
    ]);
    expect(hot.factors.find((f) => f.key === 'proposal')?.label).toBe('Abrió la propuesta 3 veces');
  });

  it('resta lo que lleva sin contestar y sin actividad, sin bajar de 0', () => {
    const cold = scorePlatformLead(
      {
        ...base,
        status: 'contacted',
        source: 'other',
        lastActivityAt: daysAgo(40),
        lastOutboundAt: daysAgo(40),
        createdAt: daysAgo(45),
      },
      NOW,
    );
    expect(cold.score).toBe(0);
    expect(cold.factors.some((f) => f.key === 'silence' && f.points === -15)).toBe(true);
    // Si contestó después de nuestro último correo, no penaliza.
    const answered = scorePlatformLead(
      {
        ...base,
        lastOutboundAt: daysAgo(20),
        lastInboundAt: daysAgo(10),
        lastActivityAt: daysAgo(10),
      },
      NOW,
    );
    expect(answered.factors.some((f) => f.key === 'silence')).toBe(false);
  });
});

describe('cuota prevista', () => {
  const ctx: PlatformLeadValueContext = {
    plans: [
      {
        slug: 'free',
        name: 'Free',
        priceMonthly: 0,
        maxUnits: 10,
        includedUnits: null,
        isActive: true,
        isPublic: true,
      },
      {
        slug: 'starter',
        name: 'Starter',
        priceMonthly: 60.5,
        maxUnits: 100,
        includedUnits: null,
        isActive: true,
        isPublic: true,
      },
      {
        slug: 'pro',
        name: 'Pro',
        priceMonthly: 121,
        maxUnits: null,
        includedUnits: null,
        isActive: true,
        isPublic: true,
      },
      {
        slug: 'basic',
        name: 'Basic',
        priceMonthly: 24.2,
        maxUnits: null,
        includedUnits: 20,
        isActive: true,
        isPublic: true,
      },
      {
        slug: 'old',
        name: 'Antiguo',
        priceMonthly: 10,
        maxUnits: null,
        includedUnits: null,
        isActive: false,
        isPublic: true,
      },
    ],
    extraUnitPrice: 1.21,
    pricesIncludeVat: true,
    taxRate: 21,
  };

  it('el plan que le interesa, sin IVA', () => {
    expect(estimatePlatformLeadValue({ units: null, planSlug: 'pro' }, ctx)).toEqual({
      monthly: 100,
      planSlug: 'pro',
      planName: 'Pro',
    });
  });

  it('sin plan, el más barato en el que caben sus trasteros (con los de más al precio del extra)', () => {
    // 40 trasteros: Basic 24,20 + 20 × 1,21 = 48,40 < Starter 60,50.
    expect(estimatePlatformLeadValue({ units: '40', planSlug: null }, ctx)).toEqual({
      monthly: 40,
      planSlug: 'basic',
      planName: 'Basic',
    });
    // 200 trasteros: Basic 24,20 + 180 × 1,21 = 242 > Pro 121.
    expect(estimatePlatformLeadValue({ units: '200', planSlug: null }, ctx)?.planSlug).toBe('pro');
  });

  it('sin trasteros ni plan no se sabe; con precios sin IVA no se descuenta', () => {
    expect(estimatePlatformLeadValue({ units: null, planSlug: null }, ctx)).toBeNull();
    expect(
      estimatePlatformLeadValue(
        { units: null, planSlug: 'pro' },
        { ...ctx, pricesIncludeVat: false },
      )?.monthly,
    ).toBe(121);
  });
});

describe('leads parados', () => {
  it('cuenta los días desde la última actividad según el umbral de su fase', () => {
    expect(
      staleDaysOf(
        { status: 'contacted', lastActivityAt: daysAgo(6), createdAt: daysAgo(20) },
        undefined,
        NOW,
      ),
    ).toBe(6);
    expect(
      staleDaysOf(
        { status: 'contacted', lastActivityAt: daysAgo(3), createdAt: daysAgo(20) },
        undefined,
        NOW,
      ),
    ).toBeNull();
    // Sin actividad, desde el alta.
    expect(
      staleDaysOf({ status: 'new', lastActivityAt: null, createdAt: daysAgo(2) }, undefined, NOW),
    ).toBe(2);
    // Cerrados no están parados.
    expect(
      staleDaysOf({ status: 'lost', lastActivityAt: null, createdAt: daysAgo(90) }, undefined, NOW),
    ).toBeNull();
  });
});

describe('plazo de primera respuesta', () => {
  it('en horas de reloj o en horas laborables (lunes a viernes, 9 a 18 en España)', () => {
    const friday5pm = new Date('2026-11-20T16:00:00Z'); // viernes 17:00 en Madrid
    expect(responseDeadline(friday5pm, 4, false).toISOString()).toBe('2026-11-20T20:00:00.000Z');
    // 1 h el viernes + 3 h el lunes desde las 9:00 → lunes 12:00 (11:00 UTC).
    expect(responseDeadline(friday5pm, 4, true).toISOString()).toBe('2026-11-23T11:00:00.000Z');
    expect(isBusinessTime(new Date('2026-11-21T10:00:00Z'))).toBe(false); // sábado
  });
});

describe('duplicados', () => {
  it('empresas parecidas sin forma jurídica ni tildes, y NIF dentro de un texto', () => {
    expect(similarCompanyNames('Trasteros Sol S.L.', 'trasteros sol')).toBe(true);
    expect(similarCompanyNames('Almacenes Pérez', 'Almacenes Perez Valencia')).toBe(true);
    expect(similarCompanyNames('Sol', 'Sol')).toBe(false);
    expect(similarCompanyNames('Trasteros Norte', 'Trasteros Sur')).toBe(false);
    expect(findTaxId('Trasteros Sol (B12345674)')).toBe('B12345674');
    expect(findTaxId('sin nif')).toBeNull();
  });
});

describe('plantillas, pasos y descartes', () => {
  it('rellena las variables del lead y de quien escribe', () => {
    expect(
      renderPlatformLeadTemplate(
        'Hola {nombre}, sobre {empresa} ({trasteros} en {ciudad}). {comercial} {desconocida}',
        { contactName: 'Ana Pérez', companyName: 'Sol', units: '120', city: 'Valencia' },
        { comercial: 'Luis' },
      ),
    ).toBe('Hola Ana, sobre Sol (120 en Valencia). Luis {desconocida}');
  });

  it('un paso necesita plantilla o asunto y texto', () => {
    expect(PlatformLeadSequenceStepSchema.safeParse({ day: 2 }).success).toBe(false);
    expect(
      PlatformLeadSequenceStepSchema.safeParse({ day: 2, subject: 'Hola', body: 'Texto' }).success,
    ).toBe(true);
  });

  it('el descarte sin motivo es «otro» y «fusionado» no se elige a mano', () => {
    expect(DiscardPlatformLeadSchema.parse({}).reasonCode).toBe('other');
    expect(DiscardPlatformLeadSchema.safeParse({ reasonCode: 'merged' }).success).toBe(false);
  });
});
