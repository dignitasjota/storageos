'use client';

import { useTranslations } from 'next-intl';

import type { AreaPageFaq, PublicAreaPageContentDto } from '@storageos/shared';

/** Texto propio de una página de zona: introducción y zonas a las que da servicio. */
export function AreaIntro({ content }: { content: PublicAreaPageContentDto | null }) {
  const t = useTranslations('publicWeb.area');
  if (!content) return null;
  const paragraphs = (content.intro ?? '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0 && content.nearbyAreas.length === 0) return null;
  return (
    <div className="mt-6 space-y-3 text-base leading-relaxed text-foreground/90">
      {paragraphs.map((p, i) => (
        <p key={i} className="whitespace-pre-line">
          {p}
        </p>
      ))}
      {content.nearbyAreas.length > 0 && (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{t('servedAreas')}</span>{' '}
          {content.nearbyAreas.join(', ')}.
        </p>
      )}
    </div>
  );
}

/** Preguntas de la página (desplegadas: es contenido que debe verse). */
export function AreaFaqs({ title, faqs }: { title: string; faqs: AreaPageFaq[] }) {
  if (faqs.length === 0) return null;
  return (
    <section className="mt-14">
      <h2 className="mb-6 text-2xl font-bold tracking-tight">{title}</h2>
      <div className="divide-y rounded-lg border bg-card">
        {faqs.map((f) => (
          <details key={f.question} className="px-5 py-4" open>
            <summary className="cursor-pointer list-none font-medium marker:content-none">
              {f.question}
            </summary>
            <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
              {f.answer}
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}
