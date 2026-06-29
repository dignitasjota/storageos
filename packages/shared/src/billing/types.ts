import type {
  AeatStatusValue,
  CorrectionMethodValue,
  DataSubjectRequestTypeValue,
  DunningActionTypeValue,
  InvoiceStatusValue,
  InvoiceTypeValue,
  PaymentGatewayProviderValue,
  PaymentMethodTypeValue,
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
  createdAt: string;
}

export interface InvoiceItemDto {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
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
  rectifiesInvoiceId: string | null;
  rectifiesInvoiceNumber: string | null;
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
  amountPending: number;
  currency: string;
  pdfUrl: string | null;
  notes: string | null;
  hash: string | null;
  previousHash: string | null;
  qrCodeUrl: string | null;
  verifactuMode: VerifactuModeValue;
  aeatSentAt: string | null;
  aeatStatus: AeatStatusValue | null;
  aeatCsv: string | null;
  holdedDocumentId: string | null;
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
  customerId: string;
  customerName: string;
  paymentMethodId: string | null;
  amount: number;
  currency: string;
  status: PaymentStatusValue;
  methodType: PaymentMethodTypeValue;
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
  pdfUrl: string | null;
}

export interface PortalSessionDto {
  customerId: string;
  customerName: string;
  email: string;
  tenantName: string;
  tenantSlug: string;
  /** JWT corto para autenticar requests del portal. */
  accessToken: string;
  expiresIn: number;
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

/** Parámetros del formulario que el navegador auto-envía a Redsys. */
export interface RedsysRedirectDto {
  url: string;
  signatureVersion: string;
  merchantParameters: string;
  signature: string;
}
