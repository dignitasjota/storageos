import { z } from 'zod';

import { isValidCustomDomain } from '../auth/schemas';

/**
 * Dominio propio de correo del tenant: sus correos a inquilinos salen desde
 * `<fromLocalPart>@<domain>` una vez autenticado en la cuenta de Brevo de la
 * plataforma. Va dentro de la funcionalidad `custom_domain`.
 */
export const EmailDomainStatuses = ['pending', 'verified', 'failed'] as const;
export type EmailDomainStatus = (typeof EmailDomainStatuses)[number];

/** Parte local de la dirección (antes de la @): letras, números, . _ - +. */
export const EMAIL_LOCAL_PART_REGEX = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/i;

export const UpsertEmailDomainSchema = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .refine(isValidCustomDomain, 'Dominio no válido (p. ej. trasteros-garcia.com)'),
  fromLocalPart: z
    .string()
    .trim()
    .toLowerCase()
    .regex(EMAIL_LOCAL_PART_REGEX, 'Solo letras, números y . _ - +')
    .default('no-reply'),
  /** Nombre visible del remitente; vacío = nombre del negocio. */
  fromName: z.string().trim().max(70).optional().or(z.literal('')),
  /** Dónde llegan las respuestas; vacío = email de facturación del negocio. */
  replyTo: z.string().trim().email().optional().or(z.literal('')),
});
export type UpsertEmailDomainInput = z.infer<typeof UpsertEmailDomainSchema>;

/** Registro DNS que el tenant debe crear en su proveedor de dominio. */
export interface EmailDnsRecordDto {
  /** Para qué sirve (código de verificación, DKIM, DMARC…). */
  label: string;
  type: string;
  host: string;
  value: string;
  /** Si el proveedor ya lo detecta correcto. */
  ok: boolean;
}

export interface EmailDomainDto {
  domain: string;
  fromAddress: string;
  fromName: string | null;
  replyTo: string | null;
  status: EmailDomainStatus;
  records: EmailDnsRecordDto[];
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  /** false si el plan ya no incluye dominio propio: se envía desde la plataforma. */
  active: boolean;
}

/** Envoltorio: un endpoint que devuelve `null` crudo manda un body vacío. */
export interface EmailDomainResponseDto {
  emailDomain: EmailDomainDto | null;
}
