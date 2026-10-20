import {
  AreaPageFaqSchema,
  type AreaPageDto,
  type AreaPageFaq,
  type PublicAreaPageContentDto,
} from '@storageos/shared';

import type { WebAreaPage } from '@storageos/database';

/** Preguntas guardadas en jsonb (se ignoran las que no casan con el esquema). */
export function parseAreaFaqs(raw: unknown): AreaPageFaq[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((f) => {
    const parsed = AreaPageFaqSchema.safeParse(f);
    return parsed.success ? [parsed.data] : [];
  });
}

export function toAreaPageDto(r: WebAreaPage): AreaPageDto {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    facilityIds: r.facilityIds,
    nearestNote: r.nearestNote,
    intro: r.intro,
    nearbyAreas: r.nearbyAreas,
    faqs: parseAreaFaqs(r.faqs),
    seoTitle: r.seoTitle,
    seoDescription: r.seoDescription,
    isPublished: r.isPublished,
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function toAreaContent(r: WebAreaPage): PublicAreaPageContentDto {
  return {
    slug: r.slug,
    name: r.name,
    facilityIds: r.facilityIds,
    nearestNote: r.nearestNote,
    intro: r.intro,
    nearbyAreas: r.nearbyAreas,
    faqs: parseAreaFaqs(r.faqs),
    seoTitle: r.seoTitle,
    seoDescription: r.seoDescription,
  };
}
