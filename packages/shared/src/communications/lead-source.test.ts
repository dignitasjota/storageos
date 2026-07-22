import { describe, expect, it } from 'vitest';

import {
  CreateLeadSchema,
  LEAD_SOURCE_SUGGESTIONS,
  leadSourceLabel,
  normalizeLeadSource,
} from './schemas';

describe('normalizeLeadSource', () => {
  it('minúsculas + sin acentos + espacios a guion bajo', () => {
    expect(normalizeLeadSource('Idealista')).toBe('idealista');
    expect(normalizeLeadSource('Habitaclia Pro')).toBe('habitaclia_pro');
    expect(normalizeLeadSource('  Boca a Boca  ')).toBe('boca_a_boca');
    expect(normalizeLeadSource('Búsqueda Móvil')).toBe('busqueda_movil');
  });

  it('colapsa símbolos y recorta guiones sobrantes', () => {
    expect(normalizeLeadSource('Google / búsqueda')).toBe('google_busqueda');
    expect(normalizeLeadSource('!!!')).toBe('');
  });
});

describe('leadSourceLabel', () => {
  it('usa la etiqueta del sugerido si existe', () => {
    expect(leadSourceLabel('idealista')).toBe('Idealista');
    expect(leadSourceLabel('portal_inmobiliario')).toBe('Portal inmobiliario');
  });

  it('capitaliza un origen propio desconocido', () => {
    expect(leadSourceLabel('habitaclia_pro')).toBe('Habitaclia pro');
  });
});

describe('CreateLeadSchema.source', () => {
  it('normaliza el origen escrito a mano', () => {
    const parsed = CreateLeadSchema.parse({ source: 'Idealista', firstName: 'Ana' });
    expect(parsed.source).toBe('idealista');
  });

  it('por defecto es manual', () => {
    const parsed = CreateLeadSchema.parse({ firstName: 'Ana' });
    expect(parsed.source).toBe('manual');
  });

  it('el catálogo de sugerencias incluye Portal inmobiliario e Idealista', () => {
    const values = LEAD_SOURCE_SUGGESTIONS.map((s) => s.value);
    expect(values).toContain('portal_inmobiliario');
    expect(values).toContain('idealista');
  });
});
