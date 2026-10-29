import { z } from 'zod';

import { SepaBicSchema, SepaIbanSchema } from '../sepa';

import type { ContractPreOpeningDto } from '../contracts/pre-opening';
import type { ContractDepositStatusValue, ContractStatusValue } from '../customers/schemas';
import type { OpeningHours } from '../facilities/schemas';

/** Idiomas soportados por el portal del inquilino. */
export const PortalLocaleEnum = z.enum(['es', 'en']);
export type PortalLocaleValue = z.infer<typeof PortalLocaleEnum>;

/** Contrato tal como lo ve el inquilino en su portal. */
export interface PortalContractDto {
  id: string;
  contractNumber: string;
  unitCode: string;
  facilityId: string;
  facilityName: string;
  status: ContractStatusValue;
  startDate: string;
  endDate: string | null;
  priceMonthly: number;
  effectivePrice: number;
  /** Cuota con IVA (lo que paga cada mes por el trastero). */
  effectivePriceWithVat: number;
  cancellationNoticeDays: number;
  endingRequestedAt: string | null;
  /** Fianza/depósito y su estado. */
  depositAmount: number;
  depositStatus: ContractDepositStatusValue;
  /** Descuento recurrente (€) y meses gratis pendientes (promoción). */
  discountAmount: number;
  freeMonthsRemaining: number;
  /** Seguro/protección de contenido contratado (null si no tiene). */
  insurancePlanId: string | null;
  insurancePlanName: string | null;
  insurancePrice: number | null;
  /** Prima del seguro con IVA. */
  insurancePriceWithVat: number | null;
  /** true si hay PDF del contrato firmado disponible para descargar. */
  hasSignedPdf: boolean;
  /** true si el trastero tiene el candado puesto por impago (expediente overlock). */
  overlocked: boolean;
  /** Reserva anticipada en un local por abrir (null si no lo es). */
  preOpening: ContractPreOpeningDto | null;
}

/** Un pago del inquilino, visto en su portal (historial de cobros). */
export interface PortalPaymentDto {
  id: string;
  amount: number;
  currency: string;
  status: string;
  methodType: string;
  /** Cuándo se cobró (ISO); null si aún no liquidado. */
  paidAt: string | null;
  /** Nº de factura asociada (si la hay). */
  invoiceNumber: string | null;
  createdAt: string;
}

/** Datos del local donde el inquilino tiene un trastero. */
export interface PortalFacilityDto {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  /** Toque de queda de acceso (HH:MM), si está activo. */
  accessCurfewEnabled: boolean;
  accessCurfewStart: string | null;
  accessCurfewEnd: string | null;
  /** Fotos del local (públicas). */
  imageUrls?: string[];
  /** Horario de apertura del local (atención), por día. */
  openingHours?: OpeningHours;
  /** Mapa para incrustar y enlace «Cómo llegar». */
  mapEmbedUrl?: string | null;
  directionsUrl?: string | null;
  /** WhatsApp del negocio (número para wa.me) si lo tiene activo. */
  whatsappNumber?: string | null;
  /** Sus trasteros en este local. */
  myUnitCodes?: string[];
  /** Planos de las plantas donde tiene trastero, con el suyo marcado. */
  plans?: PortalFacilityPlanDto[];
}

export interface PortalFacilityPlanDto {
  floorName: string;
  /** Imagen del plano (enlace temporal) o null si no tiene. */
  imageUrl: string | null;
  width: number;
  height: number;
  units: { code: string; x: number; y: number; width: number; height: number; mine: boolean }[];
}

/** URL temporal para descargar un documento (p. ej. el contrato firmado). */
export interface PortalDownloadDto {
  url: string;
}

/** Magic link de acceso al portal generado por el staff para un inquilino. */
export interface PortalMagicLinkDto {
  url: string;
  /** Caducidad del enlace (ISO). */
  expiresAt: string;
}

/** Datos de perfil del inquilino que él mismo puede ver/editar en el portal. */
export interface PortalProfileDto {
  customerType: 'individual' | 'business';
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  /** Solo lectura: el email es el identificador de acceso (lo cambia el staff). */
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  country: string;
  documentType: string | null;
  documentNumber: string | null;
  /** true si el inquilino ya tiene una contraseña de portal configurada. */
  hasPortalPassword: boolean;
  /** Idioma preferido del inquilino en el portal. */
  locale: PortalLocaleValue;
}

const optionalProfileText = (max: number) => z.string().trim().max(max).optional();

/**
 * Edición del propio perfil desde el portal. Campos opcionales: un campo
 * presente con cadena vacía se interpreta como "borrar". El email NO se puede
 * cambiar aquí (identificador de login).
 */
export const PortalUpdateProfileSchema = z.object({
  firstName: optionalProfileText(120),
  lastName: optionalProfileText(120),
  companyName: optionalProfileText(200),
  phone: optionalProfileText(40),
  address: optionalProfileText(200),
  city: optionalProfileText(120),
  postalCode: optionalProfileText(20),
  country: z.string().trim().length(2).optional(),
  documentType: optionalProfileText(30),
  documentNumber: optionalProfileText(60),
  locale: PortalLocaleEnum.optional(),
});
export type PortalUpdateProfileInput = z.infer<typeof PortalUpdateProfileSchema>;

/** Compra de accesorios desde el portal: líneas {producto, cantidad}. */
export const PortalPurchaseSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().positive().max(99),
      }),
    )
    .min(1),
});
export type PortalPurchaseInput = z.infer<typeof PortalPurchaseSchema>;

/** El inquilino contrata (planId) o quita (null) el seguro en uno de sus contratos. */
export const PortalSetInsuranceSchema = z.object({
  planId: z.string().uuid().nullable(),
});
export type PortalSetInsuranceInput = z.infer<typeof PortalSetInsuranceSchema>;

/** Solicitud de baja (move-out) desde el portal. */
export const RequestMoveOutSchema = z.object({
  /** Fecha de salida deseada (YYYY-MM-DD); debe respetar el preaviso. */
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD'),
});
export type RequestMoveOutInput = z.infer<typeof RequestMoveOutSchema>;

/** Incidencia reportada por el inquilino desde el portal. */
export const PortalReportIncidentSchema = z.object({
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().max(2000).optional(),
});
export type PortalReportIncidentInput = z.infer<typeof PortalReportIncidentSchema>;

export interface PortalIncidentDto {
  id: string;
  title: string;
  description: string | null;
  status: string;
  severity: string;
  createdAt: string;
}

/** Acceso adicional que el inquilino se crea desde el portal (familiar, etc.). */
export const PortalCreateExtraAccessSchema = z.object({
  label: z.string().trim().min(1).max(60),
});
export type PortalCreateExtraAccessInput = z.infer<typeof PortalCreateExtraAccessSchema>;

/** Disponibilidad + precio del pase nocturno (para la card del portal). */
export interface PortalNightPassInfoDto {
  enabled: boolean;
  /** Precio del pase (sin IVA; la factura añade el 21%). */
  price: number;
  /** Locales donde el inquilino tiene contrato vivo: el pase abre solo el elegido. */
  facilities: { id: string; name: string }[];
}

/** Compra del pase nocturno: el local es obligatorio si hay más de uno. */
export const PortalBuyNightPassSchema = z.object({
  facilityId: z.string().uuid().optional(),
});
export type PortalBuyNightPassInput = z.infer<typeof PortalBuyNightPassSchema>;

/** Un pase nocturno comprado por el inquilino (historial). */
export interface PortalNightPassDto {
  id: string;
  /** active = sin usar y vigente · used = ya utilizado · expired = caducó sin usar. */
  status: 'active' | 'used' | 'expired';
  createdAt: string;
  expiresAt: string | null;
  /** Local para el que se compró (null en pases anteriores a 2026-09). */
  facilityName: string | null;
}

/** Una línea de lo que paga cada mes (un contrato), con IVA. */
export interface PortalAccountLineDto {
  contractId: string;
  unitCode: string;
  facilityName: string;
  rent: number;
  insurance: number;
  insuranceName: string | null;
  total: number;
  /** 1 = mensual; 6/12 = prepago semestral/anual. */
  billingIntervalMonths: number;
  ending: boolean;
}

/** Paso del escalado de un impago que aún no ha ocurrido o ya ocurrió. */
export interface PortalDunningStepDto {
  type: 'email_reminder' | 'email_reminder_final' | 'late_fee' | 'access_block' | 'legal_notice';
  date: string;
  done: boolean;
}

/**
 * «Mi cuenta» del inquilino (`GET /portal/me/account`): lo que paga al mes
 * con IVA, cómo se le cobra, el próximo cargo y, si debe algo, cuánto y qué
 * pasará si no paga.
 */
export interface PortalAccountDto {
  monthly: number;
  lines: PortalAccountLineDto[];
  /** card | sepa_debit | sepa_mandate | null (se paga a mano). */
  payVia: 'card' | 'sepa_debit' | 'sepa_mandate' | null;
  /** Marca de la tarjeta (si es tarjeta). */
  payBrand: string | null;
  payLast4: string | null;
  /** Se cobra solo (tarjeta o adeudo guardados con cobro automático, o remesa SEPA). */
  automatic: boolean;
  /** El negocio ofrece domiciliar desde el portal (tarjeta o GoCardless). */
  canSetupAutomatic: boolean;
  nextCharge: { date: string; amount: number } | null;
  /** Ya se está cobrando (adeudo en curso o en remesa): no hay que pagarlo. */
  inProgress: number;
  overdue: {
    amount: number;
    since: string;
    days: number;
    steps: PortalDunningStepDto[];
    /** El acceso está cortado por este impago. */
    accessBlocked: boolean;
  } | null;
  /** Emitido y aún no vencido (sin contar lo que se está cobrando). */
  pendingNotDue: number;
}

/** Un aviso que el negocio le envió por correo (recordatorio, subida de precio…). */
export interface PortalNoticeDto {
  id: string;
  subject: string;
  body: string;
  sentAt: string;
}

// ============================================================================
// Formas de pago sin pasarela (transferencia, en el local, domiciliación SEPA)
// ============================================================================

export const OfflinePaymentMethodEnum = z.enum(['bank_transfer', 'cash', 'sepa_debit']);
export type OfflinePaymentMethodValue = z.infer<typeof OfflinePaymentMethodEnum>;

/** Horas que se amplía la reserva al elegir transferencia o pago en el local. */
export const OFFLINE_PAYMENT_EXTRA_HOURS = 24;

/** POST /portal/me/invoices/:id/offline-payment — cómo va a pagar el inquilino. */
export const PortalOfflinePaymentSchema = z
  .object({
    method: OfflinePaymentMethodEnum,
    /** Solo domiciliación: cuenta del inquilino. */
    iban: SepaIbanSchema.optional(),
    bic: SepaBicSchema,
  })
  .refine((v) => v.method !== 'sepa_debit' || !!v.iban, {
    message: 'Indica el IBAN de la cuenta a domiciliar',
    path: ['iban'],
  });
export type PortalOfflinePaymentInput = z.infer<typeof PortalOfflinePaymentSchema>;

/** Formas de pago que ofrece el negocio al inquilino. */
export interface PortalPaymentOptionsDto {
  /** Tarjeta por Stripe. */
  cardPayments: boolean;
  /** Transferencia (el IBAN le llega por correo). */
  bankTransfer: boolean;
  /** Pagar en el local. */
  payAtFacility: boolean;
  /** Domiciliación con la remesa SEPA del negocio. */
  sepaDebit: boolean;
}

export interface PortalOfflinePaymentResultDto {
  method: OfflinePaymentMethodValue;
  /** Hasta cuándo se guarda el trastero (null si la factura no es de una reserva). */
  holdUntil: string | null;
  /** Transferencia: a qué correo se han enviado los datos. */
  emailSentTo: string | null;
  /** Domiciliación: enlace para firmar el mandato (null si ya tenía uno firmado). */
  mandateSigningUrl: string | null;
}

// ============================================================================
// Pase de visita (PIN de un día que crea el propio inquilino)
// ============================================================================

export const PortalVisitorPassSchema = z
  .object({
    /** Nombre de quien viene (si no es una persona autorizada guardada). */
    name: z.string().trim().max(120).optional(),
    authorizedPersonId: z.string().uuid().optional(),
    /** Local de la visita (obligatorio si tiene trasteros en varios). */
    facilityId: z.string().uuid().optional(),
  })
  .refine((v) => !!v.authorizedPersonId || (v.name?.length ?? 0) >= 2, {
    message: 'Indica quién va a venir',
    path: ['name'],
  });
export type PortalVisitorPassInput = z.infer<typeof PortalVisitorPassSchema>;

/** El contrato tal y como lo firmó (texto congelado al firmar). */
export interface PortalContractTermsDto {
  contractNumber: string;
  signedAt: string | null;
  text: string | null;
  hasSignedPdf: boolean;
}

/** Facturas de un año en un ZIP (resumen CSV + PDF de cada una). */
export interface PortalAnnualInvoicesDto {
  url: string;
  year: number;
  invoices: number;
  withPdf: number;
}

/** Cambio del email de acceso: se confirma con un enlace al email nuevo. */
export const PortalEmailChangeSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
});
export type PortalEmailChangeInput = z.infer<typeof PortalEmailChangeSchema>;

export const PortalEmailChangeConfirmSchema = z.object({
  token: z.string().trim().min(10).max(300),
});

/** Preferencias de comunicación del inquilino. */
export interface PortalPreferencesDto {
  /** Recibe ofertas y campañas del negocio. */
  marketing: boolean;
  /** Recibe avisos por WhatsApp (si no, solo por correo). */
  whatsapp: boolean;
}

export const PortalPreferencesSchema = z.object({
  marketing: z.boolean().optional(),
  whatsapp: z.boolean().optional(),
});
export type PortalPreferencesInput = z.infer<typeof PortalPreferencesSchema>;
