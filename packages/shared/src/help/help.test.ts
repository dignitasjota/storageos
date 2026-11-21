import { describe, expect, it } from 'vitest';

import { mergeHelpTopics, visibleHelpTopics, type HelpTopicOverride } from './merge';
import { CreateHelpTopicSchema, UpdateHelpTopicSchema } from './schemas';
import { helpHighlightParts, helpSearchWords, relatedHelpTopics, searchHelpTopics } from './search';
import { HELP_TOPICS } from './topics';

const override = (o: Partial<HelpTopicOverride> & { topicId: string }): HelpTopicOverride => ({
  content: null,
  imageUrl: null,
  imageKey: null,
  videoUrl: null,
  position: null,
  published: true,
  hidden: false,
  updatedAt: null,
  ...o,
});

describe('buscador de guías', () => {
  it('sin búsqueda devuelve todas', () => {
    expect(searchHelpTopics(HELP_TOPICS, '  ')).toHaveLength(HELP_TOPICS.length);
  });

  it('busca sin tildes, por singular y con todas las palabras', () => {
    const ids = searchHelpTopics(HELP_TOPICS, 'Remesas').map((t) => t.id);
    expect(ids).toContain('domiciliacion');
    expect(searchHelpTopics(HELP_TOPICS, 'fianza devolver').map((t) => t.id)).toContain('bajas');
    expect(searchHelpTopics(HELP_TOPICS, 'fianza zzzz')).toHaveLength(0);
  });

  it('resalta lo encontrado sin distinguir tildes ni mayúsculas', () => {
    const parts = helpHighlightParts('Facturación y cobros', helpSearchWords('facturacion'));
    expect(parts).toEqual([
      { text: 'Facturación', match: true },
      { text: ' y cobros', match: false },
    ]);
    expect(helpHighlightParts('Las remesas', helpSearchWords('remesas'))).toEqual([
      { text: 'Las ', match: false },
      { text: 'remesas', match: true },
    ]);
    expect(helpHighlightParts('Sin nada', [])).toEqual([{ text: 'Sin nada', match: false }]);
  });

  it('las relacionadas con un texto libre van por número de palabras', () => {
    const related = relatedHelpTopics(HELP_TOPICS, 'No me sale la remesa del banco', 3);
    expect(related[0]?.id).toBe('domiciliacion');
    expect(relatedHelpTopics(HELP_TOPICS, 'hola para', 3)).toEqual([]);
    expect(relatedHelpTopics(HELP_TOPICS, 'fianza', 1)).toHaveLength(1);
  });
});

describe('combinación de guías', () => {
  it('sin cambios son las del código, en su orden', () => {
    const merged = mergeHelpTopics(HELP_TOPICS, []);
    expect(merged.map((t) => t.id)).toEqual(HELP_TOPICS.map((t) => t.id));
    expect(visibleHelpTopics(merged)).toHaveLength(HELP_TOPICS.length);
  });

  it('aplica el texto cambiado, oculta y añade las nuevas', () => {
    const merged = mergeHelpTopics(HELP_TOPICS, [
      override({
        topicId: 'alquilar',
        content: {
          group: 'Día a día',
          title: 'Alquilar, paso a paso',
          summary: 'Otro resumen.',
          steps: ['Uno'],
          links: [],
          keywords: null,
          feature: null,
        },
        videoUrl: 'https://youtu.be/abc123',
      }),
      override({ topicId: 'bajas', hidden: true }),
      override({
        topicId: 'nueva-guia',
        content: {
          group: 'Tu negocio',
          title: 'Guía nueva',
          summary: 'Resumen.',
          steps: ['Paso'],
          links: [{ label: 'Hoy', href: '/today' }],
          keywords: null,
          feature: null,
        },
        position: 0,
      }),
      override({ topicId: 'borrador', published: false, content: null }),
    ]);
    const alquilar = merged.find((t) => t.id === 'alquilar')!;
    expect(alquilar).toMatchObject({
      title: 'Alquilar, paso a paso',
      edited: true,
      source: 'code',
      videoEmbedUrl: 'https://www.youtube.com/embed/abc123',
    });
    const visible = visibleHelpTopics(merged);
    expect(visible.find((t) => t.id === 'bajas')).toBeUndefined();
    // La nueva va primera de su grupo (orden 0) y la fila sin texto se ignora.
    const negocio = visible.filter((t) => t.group === 'Tu negocio');
    expect(negocio[0]?.id).toBe('nueva-guia');
    expect(visible.find((t) => t.id === 'borrador')).toBeUndefined();
  });
});

describe('esquemas', () => {
  const content = {
    group: 'Día a día' as const,
    title: 'Título',
    summary: 'Resumen',
    steps: ['Paso'],
    links: [{ label: 'Hoy', href: '/today' }],
  };

  it('solo admite enlaces del panel', () => {
    expect(CreateHelpTopicSchema.safeParse({ id: 'nueva', content }).success).toBe(true);
    for (const href of ['https://ejemplo.com', '//ejemplo.com', 'javascript:alert(1)', '/\\x']) {
      const bad = { id: 'nueva', content: { ...content, links: [{ label: 'X', href }] } };
      expect(CreateHelpTopicSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('solo admite vídeos de YouTube o Vimeo', () => {
    expect(UpdateHelpTopicSchema.safeParse({ videoUrl: 'https://vimeo.com/123' }).success).toBe(
      true,
    );
    expect(UpdateHelpTopicSchema.safeParse({ videoUrl: 'https://ejemplo.com/v' }).success).toBe(
      false,
    );
    expect(UpdateHelpTopicSchema.safeParse({ videoUrl: '' }).success).toBe(true);
  });
});
