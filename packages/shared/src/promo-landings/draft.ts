import { z } from 'zod';

import { clipDraftText, draftJsonObject } from '../blog/draft';

/**
 * Borrador con IA de una landing de promoción: a partir de la oferta propone
 * titular, subtítulo, ventajas, condiciones y SEO con los datos reales del
 * negocio. No se guarda: rellena el formulario para revisarlo.
 */
export const DraftPromoLandingSchema = z.object({
  offer: z.string().trim().min(3, 'Describe la oferta').max(600),
  couponId: z.string().uuid().nullable().optional(),
  facilityIds: z.array(z.string().uuid()).max(100).optional(),
  unitTypeIds: z.array(z.string().uuid()).max(100).optional(),
});
export type DraftPromoLandingInput = z.infer<typeof DraftPromoLandingSchema>;

export interface PromoLandingDraftDto {
  headline: string;
  subheadline: string | null;
  benefits: { title: string; description: string }[];
  conditions: string[];
  seoTitle: string | null;
  seoDescription: string | null;
}

/** Lee la respuesta del modelo con los límites del formulario: null si falta el titular. */
export function parsePromoLandingDraft(text: string): PromoLandingDraftDto | null {
  const raw = draftJsonObject(text);
  if (!raw) return null;
  const headline = clipDraftText(raw.headline, 140);
  if (!headline) return null;
  const benefits = (Array.isArray(raw.benefits) ? raw.benefits : [])
    .map((b) => {
      const o = (b ?? {}) as Record<string, unknown>;
      const title = clipDraftText(o.title, 60);
      return title ? { title, description: clipDraftText(o.description, 240) ?? '' } : null;
    })
    .filter((b): b is { title: string; description: string } => b != null)
    .slice(0, 6);
  const conditions = (Array.isArray(raw.conditions) ? raw.conditions : [])
    .map((c) => clipDraftText(c, 400))
    .filter((c): c is string => !!c)
    .slice(0, 12);
  return {
    headline,
    subheadline: clipDraftText(raw.subheadline, 400),
    benefits,
    conditions,
    seoTitle: clipDraftText(raw.seoTitle, 70),
    seoDescription: clipDraftText(raw.seoDescription, 200),
  };
}
