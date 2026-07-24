import { z } from 'zod';

/**
 * Web «Premium»: el operador personaliza su web pública (`/s/<slug>`). En v1 elige
 * una PLANTILLA de diseño + edita el claim del hero + la sección «quiénes somos».
 * Feature `web_premium` (add-on). Sin la feature, se sirve la plantilla `default`
 * y los textos personalizados se ignoran.
 */

/** Plantillas de diseño disponibles para la web pública. */
export const WEB_TEMPLATES = [
  {
    value: 'default',
    label: 'Estándar',
    description: 'Diseño limpio centrado, la plantilla por defecto.',
  },
  {
    value: 'modern',
    label: 'Moderna',
    description: 'Hero a pantalla con color de marca y tarjetas de local.',
  },
  {
    value: 'industrial',
    label: 'Industrial',
    description: 'Estética sobria en tonos oscuros, tipografía marcada.',
  },
] as const;

export type WebTemplateValue = (typeof WEB_TEMPLATES)[number]['value'];

/** ¿Es un valor de plantilla válido? (fallback a `default` si no). */
export function isWebTemplate(value: string): value is WebTemplateValue {
  return WEB_TEMPLATES.some((t) => t.value === value);
}

const optionalWebText = (max: number) => z.string().trim().max(max).optional().or(z.literal(''));

/** Secciones activables de la web pública (v2). */
export const WebSectionsSchema = z.object({
  /** Muestra testimonios (reseñas NPS ≥ 9 con comentario). */
  testimonials: z.boolean().default(false),
  /** Muestra las preguntas frecuentes publicadas (centro de ayuda). */
  faq: z.boolean().default(false),
  /** Muestra un formulario de contacto que crea un lead. */
  contact: z.boolean().default(false),
});
export type WebSections = z.infer<typeof WebSectionsSchema>;

/** Parseo defensivo del jsonb `web_sections` (tolera `{}`). */
export function parseWebSections(raw: unknown): WebSections {
  const parsed = WebSectionsSchema.safeParse(raw);
  return parsed.success ? parsed.data : { testimonials: false, faq: false, contact: false };
}

export const UpdateWebSettingsSchema = z
  .object({
    template: z.enum(['default', 'modern', 'industrial']).optional(),
    headline: optionalWebText(160),
    about: optionalWebText(2000),
    sections: WebSectionsSchema.partial().optional(),
  })
  .refine((v) => Object.values(v).some((f) => f !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateWebSettingsInput = z.infer<typeof UpdateWebSettingsSchema>;

export interface WebSettingsResponse {
  template: WebTemplateValue;
  /** Claim del hero (null = texto por defecto). */
  headline: string | null;
  /** Sección «quiénes somos» (null = oculta). */
  about: string | null;
  sections: WebSections;
}

/** Envío del formulario de contacto de la web pública → crea un lead. */
export const PublicContactSchema = z.object({
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().max(120).optional().or(z.literal('')),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  message: z.string().trim().max(2000).optional().or(z.literal('')),
  /** Honeypot anti-bot: debe llegar vacío. */
  hp: z.string().max(0).optional().or(z.literal('')),
});
export type PublicContactInput = z.infer<typeof PublicContactSchema>;
