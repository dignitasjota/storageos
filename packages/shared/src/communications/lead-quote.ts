import { z } from 'zod';

import { FirstPaymentMonthsSchema, type FirstPaymentQuoteDto } from '../coupons';

/** Presupuesto a un contacto: tamaño, meses, cupón y seguro opcional. */
export const LeadQuoteSchema = z.object({
  facilityId: z.string().uuid(),
  unitTypeId: z.string().uuid(),
  months: FirstPaymentMonthsSchema.default(1),
  couponCode: z.string().trim().max(40).optional(),
  insurancePlanId: z.string().uuid().optional(),
});
export type LeadQuoteInput = z.infer<typeof LeadQuoteSchema>;

export const SendLeadQuoteSchema = LeadQuoteSchema.extend({
  subject: z.string().trim().min(3).max(200).optional(),
  body: z.string().trim().min(10).max(5000).optional(),
  /** Seguimiento para llamarle a los N días (0 = sin seguimiento). */
  followupInDays: z.number().int().min(0).max(30).default(3),
  /** `whatsapp`: el equipo lo manda desde su móvil; solo se registra. */
  channel: z.enum(['email', 'whatsapp']).default('email'),
});
export type SendLeadQuoteInput = z.infer<typeof SendLeadQuoteSchema>;

export interface LeadQuoteDto {
  quote: FirstPaymentQuoteDto;
  facilityName: string;
  unitTypeName: string;
  /** m² orientativos del trastero que se le reservaría. */
  areaM2: number | null;
  insuranceName: string | null;
  /** Cuota mensual con IVA después del primer pago. */
  monthlyWithVat: number;
  /** Enlace a la reserva con el local, el tamaño, los meses y el cupón ya puestos. */
  bookUrl: string;
  subject: string;
  body: string;
  /** Texto corto para mandarlo por WhatsApp desde el móvil. */
  whatsappText: string;
}

export interface SendLeadQuoteResultDto {
  /** Email al que se envió (vacío si fue por WhatsApp). */
  sentTo: string;
  /** Texto para WhatsApp (wa.me) cuando se manda desde el móvil. */
  whatsappText: string | null;
  followupId: string | null;
}
