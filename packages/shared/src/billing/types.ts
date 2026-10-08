import type { InvoiceTaxCategory } from './tax-category';
import type { InvoicingModeValue } from '../accounting';
import type { PortalLocaleValue } from '../portal';
import type {
  AeatStatusValue,
  CorrectionMethodValue,
  DataSubjectRequestTypeValue,
  DunningActionTypeValue,
  InvoiceStatusValue,
  InvoiceTypeValue,
  PaymentGatewayProviderValue,
  PaymentMethodTypeValue,
  PaymentRecordMethodValue,
  PaymentStatusValue,
  PriceModifierTypeValue,
  PricingRuleScopeValue,
  PricingRuleTypeValue,
  PromotionDiscountTypeValue,
  VerifactuModeValue,
} from './schemas';

export interface InvoiceSeriesDto {
  id: string;
  code: string;
  name: string;
  prefix: string;
  yearScope: boolean;
  nextNumber: number;
  facilityId: string | null;
  isActive: boolean;
  isDefault: boolean;
  /** Serie de rectificativas (la crea la app; las rectificativas van siempre aquí). */
  isRectification: boolean;
  createdAt: string;
}

export interface InvoiceItemDto {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  taxCategory: InvoiceTaxCategory;
  taxAmount: number;
  total: number;
  relatedContractId: string | null;
  relatedUnitId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  position: number;
}

export interface InvoiceDto {
  id: string;
  invoiceNumber: string;
  seriesId: string;
  seriesCode: string;
  sequenceNumber: number;
  /**
   * Nullable a partir de Fase 13A.3: en facturas simplificadas (F2) el
   * destinatario puede no estar identificado.
   */
  customerId: string | null;
  customerName: string | null;
  contractId: string | null;
  contractNumber: string | null;
  /** Trastero y local del contrato facturado (null en F2 o facturas sin contrato). */
  unitId: string | null;
  unitCode: string | null;
  facilityId: string | null;
  facilityName: string | null;
  status: InvoiceStatusValue;
  invoiceType: InvoiceTypeValue;
  /** `deposit_receipt`: justificante de fianza (no es factura: sin IVA ni Veri*Factu). */
  kind: InvoiceKind;
  /** Justificante: factura con la que se cobra en un solo pago. */
  bundledWithInvoiceId: string | null;
  rectifiesInvoiceId: string | null;
  rectifiesInvoiceNumber: string | null;
  /** Rectificativas emitidas sobre esta factura (p. ej. la de abono al anularla). */
  rectifiedBy: {
    id: string;
    invoiceNumber: string | null;
    status: InvoiceStatusValue;
    total: number;
  }[];
  rectificationReason: string | null;
  /** Si esta factura es un recargo por mora, la factura vencida que lo originó. */
  lateFeeForInvoiceId: string | null;
  /** Si esta factura (vencida) ya tiene un recargo emitido, la factura de recargo. */
  lateFeeInvoiceId: string | null;
  correctionMethod: CorrectionMethodValue | null;
  issueDate: string | null;
  dueDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  subtotal: number;
  taxAmount: number;
  total: number;
  amountPaid: number;
  amountRefunded: number;
  /** % de retención de IRPF (0 = sin retención). */
  withholdingPct: number;
  /** Retención de IRPF: se resta del total a pagar (el total no cambia). */
  withholdingAmount: number;
  /** Total a pagar = total − retención. */
  amountDue: number;
  amountPending: number;
  currency: string;
  /**
   * El PDF NO viaja aquí como URL permanente (bucket privado, sin firmar):
   * pedir `GET /invoices/:id/signed-pdf` cuando `true` da una URL firmada de
   * corta duración.
   */
  hasPdf: boolean;
  notes: string | null;
  hash: string | null;
  previousHash: string | null;
  qrCodeUrl: string | null;
  verifactuMode: VerifactuModeValue;
  aeatSentAt: string | null;
  aeatStatus: AeatStatusValue | null;
  aeatCsv: string | null;
  holdedDocumentId: string | null;
  /** Sistema que emitió la factura: la app (Veri*Factu) o Holded. */
  issuedBy: InvoicingModeValue;
  paidAt: string | null;
  cancelledAt: string | null;
  items: InvoiceItemDto[];
  createdAt: string;
  updatedAt: string;
}

export interface PaymentDto {
  id: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  customerId: string | null;
  customerName: string;
  paymentMethodId: string | null;
  amount: number;
  currency: string;
  status: PaymentStatusValue;
  methodType: PaymentRecordMethodValue;
  gateway: PaymentGatewayProviderValue;
  gatewayPaymentId: string | null;
  paidAt: string | null;
  refundedAt: string | null;
  refundedAmount: number;
  failureReason: string | null;
  createdAt: string;
}

export interface PaymentMethodDto {
  id: string;
  customerId: string;
  type: PaymentMethodTypeValue;
  gateway: PaymentGatewayProviderValue;
  last4: string | null;
  brand: string | null;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
  mandateReference: string | null;
  createdAt: string;
}

export interface SetupIntentResponseDto {
  clientSecret: string;
  setupIntentId: string;
  customerId: string;
  /** Publishable key del tenant (mismo para todos en MVP). */
  publishableKey: string;
}

export interface DunningActionDto {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  actionType: DunningActionTypeValue;
  status: 'scheduled' | 'executed' | 'failed' | 'cancelled';
  scheduledFor: string;
  executedAt: string | null;
  notes: string | null;
}

export interface PricingRuleDto {
  id: string;
  name: string;
  scope: PricingRuleScopeValue;
  targetId: string | null;
  ruleType: PricingRuleTypeValue;
  conditions: Record<string, unknown>;
  modifierType: PriceModifierTypeValue;
  modifierValue: number;
  validFrom: string | null;
  validUntil: string | null;
  priority: number;
  isActive: boolean;
}

export interface PromotionDto {
  id: string;
  code: string;
  name: string;
  discountType: PromotionDiscountTypeValue;
  discountValue: number;
  appliesTo: Record<string, unknown>;
  maxUses: number | null;
  usedCount: number;
  validFrom: string | null;
  validUntil: string | null;
  isActive: boolean;
  createdAt: string;
}

/** Resultado de validar/previsualizar un código promocional. */
export interface ValidatePromotionResultDto {
  valid: boolean;
  /** Motivo si `valid` es false (not_found | inactive | expired | not_started | max_uses_reached | unsupported_type). */
  reason: string | null;
  code: string;
  discountType: PromotionDiscountTypeValue | null;
  /** Descuento mensual resultante (€) sobre el precio dado. */
  discountAmount: number;
  /** Precio mensual tras el descuento. */
  effectivePrice: number;
  /** Meses gratis (solo promociones `free_months`); null en otros tipos. */
  freeMonths: number | null;
}

export interface DataSubjectRequestDto {
  id: string;
  customerId: string | null;
  email: string;
  requestType: DataSubjectRequestTypeValue;
  status: 'open' | 'in_progress' | 'fulfilled' | 'denied';
  submittedAt: string;
  dueAt: string;
  fulfilledAt: string | null;
  exportFileUrl: string | null;
  notes: string | null;
}

export interface BillingMetricsDto {
  /** Monthly Recurring Revenue (suma de cuotas efectivas de contratos active+ending). */
  mrr: number;
  /** Importe pendiente de cobro (issued + overdue). */
  outstanding: number;
  /** Facturas vencidas (count). */
  overdueCount: number;
  /** Facturas pagadas este mes. */
  paidThisMonth: number;
  /** Importe cobrado este mes. */
  collectedThisMonth: number;
  /** Top 5 clientes por facturado en los ultimos 12 meses. */
  topCustomers: Array<{
    customerId: string;
    customerName: string;
    total: number;
  }>;
}

/** Respuesta del portal del cliente (lectura de sus facturas). */
export interface PortalInvoiceDto {
  id: string;
  invoiceNumber: string;
  issueDate: string | null;
  dueDate: string | null;
  total: number;
  amountPaid: number;
  amountPending: number;
  status: InvoiceStatusValue;
  /** Pedir `POST /portal/me/invoices/:id/signed-pdf` cuando `true` da una URL firmada de corta duración. */
  hasPdf: boolean;
  /** Hay un cobro en curso (SEPA/GoCardless `processing`) sobre esta factura. */
  paymentInProgress: boolean;
  /** `deposit_receipt`: justificante de fianza (se paga junto a su factura). */
  kind: InvoiceKind;
  /**
   * Factura: lo pendiente de su justificante de fianza, que se cobra en el
   * mismo pago (0 si no tiene). Justificante: id de la factura con la que se
   * paga mientras esa siga pendiente (entonces no tiene botón propio).
   */
  bundledReceiptPending: number;
  paidWithInvoiceId: string | null;
}

/** Factura o justificante de fianza (no es factura: fuera de IVA y Veri*Factu). */
export type InvoiceKind = 'invoice' | 'deposit_receipt';

export interface PortalSessionDto {
  customerId: string;
  customerName: string;
  email: string;
  tenantName: string;
  tenantSlug: string;
  /** White-label: color de marca (hex) y logo del operador (null si no configurado). */
  brandColor: string | null;
  logoUrl: string | null;
  /** JWT corto para autenticar requests del portal. */
  accessToken: string;
  expiresIn: number;
  /** Idioma preferido del inquilino (persistido en su perfil). */
  locale: PortalLocaleValue;
}

/** Resultado del cobro lanzado desde el portal (`POST /portal/me/invoices/:id/charge`). */
export interface PortalChargeResultDto {
  paymentId: string;
  status: PaymentStatusValue;
  failureReason: string | null;
}

export interface RedsysSettingsDto {
  merchantCode: string;
  terminal: string;
  environment: 'test' | 'live';
  enabled: boolean;
  /** El comercio acepta Bizum (el banco debe tenerlo activo en el TPV). */
  bizumEnabled: boolean;
  /** true si hay clave secreta guardada (nunca se devuelve). */
  hasSecretKey: boolean;
}

/** Config de GoCardless por tenant (nunca devuelve el token ni el secret). */
export interface GoCardlessSettingsDto {
  environment: 'sandbox' | 'live';
  enabled: boolean;
  /** true si hay access token guardado. */
  hasAccessToken: boolean;
  /** true si hay webhook secret guardado. */
  hasWebhookSecret: boolean;
}

/** Resultado de probar la conexión con GoCardless. */
export interface GoCardlessTestResultDto {
  ok: boolean;
  /** Nombre del acreedor (creditor) si la conexión funciona. */
  creditorName: string | null;
  error: string | null;
}

/** Inicio del mandato GoCardless: URL a la que mandar al cliente a autorizar. */
export interface GoCardlessMandateStartDto {
  authorisationUrl: string;
  billingRequestId: string;
}

/** Parámetros del formulario que el navegador auto-envía a Redsys. */
export interface RedsysRedirectDto {
  url: string;
  signatureVersion: string;
  merchantParameters: string;
  signature: string;
}

/** Resultado de una acción en lote sobre facturas: cuáles fueron OK y cuáles no. */
export interface BulkInvoiceActionResultDto {
  succeeded: string[];
  failed: { id: string; error: string }[];
}

/** Oferta activa de un trastero concreto. */
export interface UnitOfferDto {
  promotionId: string;
  unitId: string;
  code: string;
  freeMonths: number;
  validUntil: string;
}

/**
 * Recibo devuelto: un cobro ya cobrado que se ha devuelto (banco, contracargo
 * de tarjeta, fallo tardío de la domiciliación) o un adeudo que el banco
 * rechazó al confirmar la remesa SEPA.
 */
export type ReturnedReceiptKind =
  | 'bank_return'
  | 'chargeback'
  | 'direct_debit_return'
  | 'sepa_rejected';

export interface ReturnedReceiptDto {
  /** Id del cobro devuelto o del adeudo rechazado. */
  id: string;
  kind: ReturnedReceiptKind;
  /** ISO. Fecha de la devolución (o de la confirmación de la remesa). */
  date: string;
  amount: number;
  reason: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  /** Estado actual de la factura (si ya se volvió a cobrar, `paid`). */
  invoiceStatus: string | null;
  /** Lo que sigue pendiente de esa factura. */
  invoicePending: number;
  customerId: string | null;
  customerName: string | null;
  facilityName: string | null;
  /** Remesa SEPA del adeudo, si viene de una. */
  remittanceName: string | null;
}

export interface ReturnedReceiptsDto {
  from: string;
  to: string;
  items: ReturnedReceiptDto[];
  totals: {
    count: number;
    amount: number;
    /** Importe que sigue sin cobrar de las facturas afectadas. */
    stillPending: number;
    byKind: { kind: ReturnedReceiptKind; count: number; amount: number }[];
  };
}
