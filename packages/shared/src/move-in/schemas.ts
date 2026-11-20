import { z } from 'zod';

import { calendarDate } from '../common/calendar-date';
import { AdClickIdsSchema, utmFields } from '../communications/schemas';
import { FirstPaymentMonthsSchema } from '../coupons';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD');

/** Firma pública (remota o self-service) enviada por el inquilino. */
export const PublicSignSubmitSchema = z
  .object({
    signerName: z.string().trim().min(2, 'Nombre requerido').max(160),
    method: z.enum(['drawn', 'typed']),
    /** Data URL PNG de la firma dibujada (si method=drawn). Máx ~2 MB. */
    signatureImage: z.string().max(2_000_000).optional(),
    typedSignature: z.string().trim().max(160).optional(),
    accept: z.literal(true, { errorMap: () => ({ message: 'Debes aceptar para firmar' }) }),
    /**
     * Huella del texto que vio el firmante (`termsHash` de la vista). Si el
     * contrato cambió entretanto, la firma se rechaza (409 `terms_changed`).
     */
    termsHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    /**
     * Huella de las Condiciones Generales de Contratación que aceptó (casilla
     * obligatoria antes de pagar). Sin ella → 400 `general_terms_required`; si
     * cambiaron entretanto → 409 `general_terms_changed`.
     */
    generalTermsHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    /**
     * Pide expresamente empezar a usar el trastero antes de que acabe el plazo
     * de desistimiento (art. 98.8 TRLGDCU). Obligatoria si el alquiler empieza
     * dentro de ese plazo (400 `immediate_start_required`).
     */
    immediateStart: z.boolean().optional(),
  })
  .refine((v) => (v.method === 'drawn' ? !!v.signatureImage : !!v.typedSignature?.trim()), {
    message: 'Falta la firma',
    path: ['method'],
  });
export type PublicSignSubmitInput = z.infer<typeof PublicSignSubmitSchema>;

/** Acepta las condiciones generales antes de pagar (contrato ya firmado). */
export const AcceptGeneralTermsSchema = z.object({
  generalTermsHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type AcceptGeneralTermsInput = z.infer<typeof AcceptGeneralTermsSchema>;

/** Alta self-service desde la web pública (move-in). */
export const PublicBookingSchema = z.object({
  facilityId: z.string().uuid(),
  unitTypeId: z.string().uuid(),
  /** Enlace de la lista de espera: reserva el trastero guardado para esta persona. */
  holdToken: z.string().max(100).optional(),
  startDate: dateOnly,
  customer: z.object({
    firstName: z.string().trim().min(1, 'Obligatorio').max(100),
    lastName: z.string().trim().min(1, 'Obligatorio').max(120),
    email: z.string().trim().toLowerCase().email(),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[\d\s().-]{9,20}$/, 'Teléfono no válido'),
    documentNumber: z.string().trim().min(5, 'Documento no válido').max(40),
  }),
  /** Código de referido opcional (best-effort). */
  referralCode: z.string().trim().toUpperCase().max(32).optional().or(z.literal('')),
  /** Meses que se pagan ahora (1, 3, 6 o 12); después, mensual. */
  months: FirstPaymentMonthsSchema.default(1),
  /** Cupón de descuento sobre el pago de ahora. */
  couponCode: z.string().trim().toUpperCase().max(40).optional().or(z.literal('')),
  /** Honeypot anti-bot: debe venir vacío. */
  website: z.string().optional(),
  /** Id aleatorio del navegador: enlaza la reserva con la conversación del chat de la web. */
  visitorId: z
    .string()
    .trim()
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  ...utmFields,
  /** `utm_content`: el id de la landing de promoción desde la que se reserva. */
  utmContent: z.string().trim().max(120).optional(),
  clickIds: AdClickIdsSchema.optional(),
});
export type PublicBookingInput = z.infer<typeof PublicBookingSchema>;

/**
 * Captura email-first del booking: guarda un lead en cuanto el visitante deja su
 * email, para no perderlo si abandona antes de completar la reserva. Idempotente
 * por email (best-effort, no bloquea el flujo).
 */
export const CaptureBookingLeadSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  firstName: z.string().trim().max(100).optional().or(z.literal('')),
  facilityId: z.string().uuid().optional(),
  unitTypeId: z.string().uuid().optional(),
  /** Honeypot anti-bot: debe venir vacío. */
  website: z.string().optional(),
  ...utmFields,
  clickIds: AdClickIdsSchema.optional(),
});
export type CaptureBookingLeadInput = z.infer<typeof CaptureBookingLeadSchema>;

/** Lo más que se puede alargar el plazo para firmar y pagar, desde la reserva o la firma. */
export const PAYMENT_DEADLINE_MAX_DAYS = 30;

/**
 * Ampliar el plazo para firmar y pagar un contrato (reserva online o enviado
 * por enlace): unos días más o hasta una fecha (fin de ese día en la hora del
 * local).
 */
export const ExtendPaymentDeadlineSchema = z
  .object({
    days: z.number().int().min(1).max(PAYMENT_DEADLINE_MAX_DAYS).optional(),
    /** YYYY-MM-DD */
    until: calendarDate.optional(),
    reason: z.string().trim().max(300).optional(),
    /** Avisar al inquilino por correo (con el enlace para firmar o pagar). */
    notifyCustomer: z.boolean().default(true),
  })
  .refine((v) => (v.days === undefined) !== (v.until === undefined), {
    message: 'Indica los días o la fecha',
  });
export type ExtendPaymentDeadlineInput = z.infer<typeof ExtendPaymentDeadlineSchema>;
