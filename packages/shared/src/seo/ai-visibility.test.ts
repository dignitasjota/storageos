import { describe, expect, it } from 'vitest';

import {
  UpdateSeoAiTrackedPromptsSchema,
  seoAiBrandSubject,
  seoAiPromptGaps,
  seoAiPromptKey,
  seoAiVisibilityLostAlert,
} from './ai-visibility';

const row = (prompt: string, model = 'aio') => ({
  prompt,
  promptKey: seoAiPromptKey(prompt),
  model,
});

describe('Visibilidad en IA (PR 12)', () => {
  it('clave del prompt: minúsculas, espacios y signos de los bordes fuera', () => {
    expect(seoAiPromptKey('  ¿Mejores   trasteros en Valencia? ')).toBe(
      'mejores trasteros en valencia',
    );
    expect(seoAiBrandSubject(['Guárdalo', 'box', 'guárdalo'])).toBe('box | guárdalo');
    expect(seoAiBrandSubject([])).toBeNull();
  });

  it('prompts en los que sale la competencia y tú no, los de más competidores primero', () => {
    const gaps = seoAiPromptGaps({
      own: [row('trasteros valencia')],
      competitors: [
        { subject: 'a.es', prompts: [row('Trasteros Valencia'), row('guardamuebles', 'chatgpt')] },
        { subject: 'b.es', prompts: [row('guardamuebles'), row('trastero 24 horas')] },
      ],
    });
    expect(gaps.map((g) => g.promptKey)).toEqual(['guardamuebles', 'trastero 24 horas']);
    expect(gaps[0]).toMatchObject({ competitors: ['a.es', 'b.es'], models: ['aio', 'chatgpt'] });
  });

  it('alerta al dejar de salir en prompts en los que salías; sin pérdida, nada', () => {
    const base = {
      projectId: 'p1',
      latestDate: '2026-11-01',
      previousDate: '2026-10-01',
      minLost: 1,
    };
    expect(
      seoAiVisibilityLostAlert({ ...base, latest: [row('a'), row('b')], previous: [row('a')] }),
    ).toBeNull();
    const lost = seoAiVisibilityLostAlert({
      ...base,
      latest: [row('a')],
      previous: [row('a'), row('b'), row('c')],
    });
    expect(lost).toMatchObject({
      type: 'ai_visibility_lost',
      key: 'ai_visibility_lost|p1',
      severity: 'medium',
      data: { lostCount: 2, before: 3, now: 1 },
    });
    expect(seoAiVisibilityLostAlert({ ...base, latest: [], previous: [row('a')] })?.severity).toBe(
      'high',
    );
    expect(
      seoAiVisibilityLostAlert({
        ...base,
        minLost: 3,
        latest: [row('a')],
        previous: [row('a'), row('b')],
      }),
    ).toBeNull();
  });

  it('los prompts que se siguen: sin repetidos y con tope', () => {
    const parsed = UpdateSeoAiTrackedPromptsSchema.parse({
      prompts: ['Trasteros valencia', 'trasteros  valencia?', 'guardamuebles'],
    });
    expect(parsed.prompts).toEqual(['Trasteros valencia', 'guardamuebles']);
    expect(
      UpdateSeoAiTrackedPromptsSchema.safeParse({
        prompts: Array.from({ length: 21 }, (_, i) => `prompt ${i}`),
      }).success,
    ).toBe(false);
  });
});
