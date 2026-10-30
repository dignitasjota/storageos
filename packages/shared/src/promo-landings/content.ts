import { z } from 'zod';

/**
 * Contenido de una landing de promoción: los textos de cada bloque, qué
 * bloques se ven y en qué orden. Solo texto: los colores, las esquinas y los
 * botones salen de la plantilla de la web; los precios y la disponibilidad, de
 * los tamaños reales; el descuento, del cupón (se comprueba al reservar).
 */

/**
 * Qué hace un botón. Nunca una dirección libre: reservar lleva a la reserva de
 * la web (con el cupón, el local y la campaña), el resto baja a una sección o
 * usa el teléfono / WhatsApp que el negocio ya tiene configurado.
 */
export const PROMO_CTA_ACTIONS = ['book', 'sizes', 'form', 'call', 'whatsapp'] as const;
export type PromoCtaAction = (typeof PROMO_CTA_ACTIONS)[number];
export const PROMO_CTA_ACTION_LABELS: Record<PromoCtaAction, string> = {
  book: 'Ir a la reserva online',
  sizes: 'Bajar a los tamaños',
  form: 'Bajar al formulario',
  call: 'Llamar al local',
  whatsapp: 'Abrir WhatsApp',
};

/** Bloques que se pueden reordenar (la barra, la portada y la oferta van siempre arriba). */
export const PROMO_SECTION_KEYS = [
  'benefits',
  'sizes',
  'steps',
  'promotion',
  'conditions',
  'testimonials',
  'faq',
  'contact',
] as const;
export type PromoSectionKey = (typeof PROMO_SECTION_KEYS)[number];
export const PROMO_SECTION_LABELS: Record<PromoSectionKey, string> = {
  benefits: 'Ventajas',
  sizes: 'Tamaños y precios',
  steps: 'Pasos',
  promotion: 'Bloque de la promoción',
  conditions: 'Condiciones',
  testimonials: 'Opiniones',
  faq: 'Preguntas frecuentes',
  contact: 'Formulario de contacto',
};

const text = (max: number, fallback = '') => z.string().trim().max(max).default(fallback);
const list = <T extends z.ZodTypeAny>(item: T, max: number, fallback: z.input<T>[] = []) =>
  z.array(item).max(max).default(fallback);

const ctaSchema = (label: string, action: PromoCtaAction) =>
  z
    .object({
      label: z.string().trim().min(1).max(40).default(label),
      action: z.enum(PROMO_CTA_ACTIONS).default(action),
    })
    .default({ label, action });

const optionalCta = z
  .object({
    label: z.string().trim().min(1).max(40),
    action: z.enum(PROMO_CTA_ACTIONS),
  })
  .nullable();

const head = (eyebrow: string, title: string, description = '') => ({
  eyebrow: text(60, eyebrow),
  title: text(120, title),
  description: text(400, description),
});

export const PromoLandingContentSchema = z.object({
  topbar: z
    .object({ enabled: z.boolean().default(false), text: text(160) })
    .default({ enabled: false, text: '' }),
  hero: z
    .object({
      eyebrow: text(80),
      primaryCta: ctaSchema('Reservar ahora', 'book'),
      secondaryCta: optionalCta.default({ label: 'Ver tamaños', action: 'sizes' }),
      trustItems: list(z.string().trim().min(1).max(60), 4),
      imageAlt: text(120),
    })
    .default({}),
  offer: z
    .object({
      enabled: z.boolean().default(false),
      eyebrow: text(40),
      title: text(40),
      subtitle: text(120),
      highlight: text(120),
      conditionsLink: text(60, 'Ver condiciones de la promoción'),
    })
    .default({}),
  benefits: z
    .object({
      enabled: z.boolean().default(false),
      ...head('Por qué elegirnos', 'Tu espacio extra, sin complicaciones'),
      items: list(
        z.object({
          icon: text(8),
          title: z.string().trim().min(1).max(60),
          description: text(240),
        }),
        6,
      ),
    })
    .default({}),
  sizes: z
    .object({
      enabled: z.boolean().default(true),
      ...head(
        'Encuentra tu tamaño',
        '¿Cuánto espacio necesitas?',
        'Precios con IVA incluido. La disponibilidad se confirma al reservar.',
      ),
      /** Texto propio por tamaño (id del tipo de trastero → texto). */
      descriptions: z.record(z.string().uuid(), z.string().trim().max(160)).default({}),
    })
    .default({}),
  steps: z
    .object({
      enabled: z.boolean().default(false),
      ...head('Así de sencillo', 'Consigue tu trastero en 3 pasos'),
      items: list(z.object({ title: z.string().trim().min(1).max(80), description: text(240) }), 6),
    })
    .default({}),
  promotion: z
    .object({
      enabled: z.boolean().default(false),
      ...head('Promoción', ''),
      panelTitle: text(120),
      panelText: text(1000),
      terms: text(400),
      conditionsLink: text(60, 'Leer condiciones completas'),
      cta: ctaSchema('Lo quiero', 'book'),
    })
    .default({}),
  conditions: z
    .object({
      enabled: z.boolean().default(false),
      ...head('Información importante', 'Condiciones de la promoción'),
      items: list(z.string().trim().min(1).max(400), 12),
      closing: text(600),
      cta: optionalCta.default(null),
    })
    .default({}),
  testimonials: z
    .object({
      enabled: z.boolean().default(true),
      title: text(120, 'Lo que dicen nuestros clientes'),
    })
    .default({}),
  faq: z
    .object({
      enabled: z.boolean().default(true),
      ...head('Preguntas frecuentes', 'Resolvemos tus dudas'),
      items: list(
        z.object({
          question: z.string().trim().min(1).max(200),
          answer: z.string().trim().min(1).max(1500),
        }),
        12,
      ),
      /** Sin preguntas propias, las del centro de ayuda del negocio. */
      useBusinessFaq: z.boolean().default(true),
    })
    .default({}),
  contact: z
    .object({
      enabled: z.boolean().default(true),
      ...head(
        'Contacta con nosotros',
        '¿Te llamamos?',
        'Déjanos tus datos y te contamos qué trasteros quedan libres y cómo contratar.',
      ),
      trust: list(z.string().trim().min(1).max(60), 4),
      buttonLabel: text(40, 'Solicitar información'),
      legal: text(400),
      successMessage: text(200, 'Hemos recibido tu solicitud. Te contactaremos pronto.'),
    })
    .default({}),
  /** Orden de los bloques reordenables (los que falten van al final). */
  order: z
    .array(z.enum(PROMO_SECTION_KEYS))
    .max(PROMO_SECTION_KEYS.length)
    .default([...PROMO_SECTION_KEYS]),
});
export type PromoLandingContent = z.output<typeof PromoLandingContentSchema>;
export type PromoLandingContentInput = z.input<typeof PromoLandingContentSchema>;

/** El contenido de una landing nueva (bloques por defecto, textos neutros). */
export function defaultPromoLandingContent(): PromoLandingContent {
  return PromoLandingContentSchema.parse({});
}

/**
 * El contenido guardado completado con los valores por defecto. Si algo no
 * cumple el esquema (versión antigua), se queda con lo que sí vale.
 */
export function parsePromoLandingContent(raw: unknown): PromoLandingContent {
  const parsed = PromoLandingContentSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  const base = defaultPromoLandingContent();
  if (!raw || typeof raw !== 'object') return base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const field = PromoLandingContentSchema.shape[k as keyof PromoLandingContent];
    if (!field) continue;
    const one = field.safeParse(v);
    if (one.success) out[k] = one.data;
  }
  return out as PromoLandingContent;
}

/** Orden final de los bloques: el guardado, sin repetidos, y los que falten al final. */
export function promoSectionOrder(order: readonly PromoSectionKey[]): PromoSectionKey[] {
  const seen = new Set<PromoSectionKey>();
  const out: PromoSectionKey[] = [];
  for (const k of [...order, ...PROMO_SECTION_KEYS]) {
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

// ============================================================================
// Formulario de la landing
// ============================================================================

/** Teléfono con al menos 9 cifras (admite espacios, guiones y prefijo). */
const PHONE_RE = /^\+?[\d\s().-]{9,30}$/;

export const PromoLeadSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z
    .string()
    .trim()
    .regex(PHONE_RE, 'Teléfono no válido')
    .refine((v) => v.replace(/\D/g, '').length >= 9, 'Teléfono no válido'),
  email: z.string().trim().toLowerCase().email().max(200).optional().or(z.literal('')),
  /** Tamaño que pide (uno de los de la landing), o vacío si no lo tiene claro. */
  unitTypeId: z.string().uuid().optional().or(z.literal('')),
  acceptPrivacy: z.literal(true),
  /** Casilla aparte: acepta recibir ofertas. */
  acceptsMarketing: z.boolean().optional(),
  /** Campo trampa contra robots: debe llegar vacío. */
  hp: z.string().max(0).optional().or(z.literal('')),
  utmSource: z.string().trim().max(120).optional(),
  utmMedium: z.string().trim().max(120).optional(),
  utmCampaign: z.string().trim().max(160).optional(),
});
export type PromoLeadInput = z.infer<typeof PromoLeadSchema>;
