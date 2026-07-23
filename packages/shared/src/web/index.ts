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

export const UpdateWebSettingsSchema = z
  .object({
    template: z.enum(['default', 'modern', 'industrial']).optional(),
    headline: optionalWebText(160),
    about: optionalWebText(2000),
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
}
