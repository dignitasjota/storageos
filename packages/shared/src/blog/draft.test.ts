import { describe, expect, it } from 'vitest';

import { faqInLanguage, faqTranslationComplete } from '../faq';
import { parsePromoLandingDraft } from '../promo-landings/draft';

import { clipDraftText, parseBlogPostDraft } from './draft';

describe('parseBlogPostDraft', () => {
  const content = '## Cómo elegir\n\n'.concat('Texto útil sobre trasteros. '.repeat(5));

  it('lee el borrador y recorta los textos largos', () => {
    const d = parseBlogPostDraft(
      `Aquí va: ${JSON.stringify({
        title: 'Cómo elegir trastero',
        excerpt: 'Resumen',
        contentMarkdown: content,
        seoTitle: 'x'.repeat(200),
        seoDescription: '',
      })}`,
    );
    expect(d?.title).toBe('Cómo elegir trastero');
    expect(d?.contentMarkdown).toBe(content.trim());
    expect(d?.seoTitle?.length).toBeLessThanOrEqual(160);
    expect(d?.seoDescription).toBeNull();
  });

  it('sin título, sin texto o sin JSON no vale', () => {
    expect(parseBlogPostDraft('nada')).toBeNull();
    expect(parseBlogPostDraft(JSON.stringify({ title: '', contentMarkdown: content }))).toBeNull();
    expect(parseBlogPostDraft(JSON.stringify({ title: 'T', contentMarkdown: 'corto' }))).toBeNull();
  });

  it('recorta sin partir palabras', () => {
    expect(clipDraftText('uno dos tres cuatro', 9)).toBe('uno dos');
    expect(clipDraftText(42, 9)).toBeNull();
  });
});

describe('parsePromoLandingDraft', () => {
  it('lee titular, ventajas y condiciones con sus topes', () => {
    const d = parsePromoLandingDraft(
      JSON.stringify({
        headline: 'Primer mes gratis',
        subheadline: 'En todos los tamaños',
        benefits: Array.from({ length: 9 }, (_, i) => ({ title: `V${i}`, description: 'd' })),
        conditions: ['Mínimo 3 meses', '', 7],
        seoTitle: 'Trasteros con primer mes gratis',
      }),
    );
    expect(d?.headline).toBe('Primer mes gratis');
    expect(d?.benefits).toHaveLength(6);
    expect(d?.conditions).toEqual(['Mínimo 3 meses']);
    expect(d?.seoDescription).toBeNull();
  });

  it('sin titular no vale', () => {
    expect(parsePromoLandingDraft(JSON.stringify({ subheadline: 'x' }))).toBeNull();
  });
});

describe('faqInLanguage', () => {
  const f = { question: '¿Hay fianza?', answer: 'Sí', questionEn: 'Deposit?', answerEn: 'Yes' };

  it('en inglés usa la traducción completa; si falta, la española', () => {
    expect(faqInLanguage(f, 'en')).toEqual({ question: 'Deposit?', answer: 'Yes' });
    expect(faqInLanguage(f, 'en-GB').question).toBe('Deposit?');
    expect(faqInLanguage(f, 'es').question).toBe('¿Hay fianza?');
    expect(faqInLanguage({ ...f, answerEn: '' }, 'en').question).toBe('¿Hay fianza?');
  });

  it('la traducción va completa o no va', () => {
    expect(faqTranslationComplete({ questionEn: 'Q', answerEn: 'A' })).toBe(true);
    expect(faqTranslationComplete({})).toBe(true);
    expect(faqTranslationComplete({ questionEn: 'Q', answerEn: ' ' })).toBe(false);
  });
});
