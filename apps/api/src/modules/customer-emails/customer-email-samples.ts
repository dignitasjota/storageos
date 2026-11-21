import type { CustomerEmailData } from './customer-emails.templates';
import type { CustomerEmailKind } from '@storageos/shared';

/**
 * Datos del negocio con los que se rellena la vista previa de un correo al
 * inquilino: lo que haya de verdad (su primer local, un trastero y su cuota,
 * el último número de factura) y, si falta algo, valores de ejemplo creíbles.
 */
export interface CustomerEmailSampleContext {
  locale: 'es' | 'en';
  tenantName: string;
  facilityName: string;
  unitCode: string;
  /** Cuota mensual con IVA. */
  monthlyWithVat: number;
  invoiceNumber: string;
  contractNumber: string;
  transferIban: string | null;
  creditorName: string;
  creditorId: string;
  /** Reserva online del negocio (botón de «Volver a reservar»). */
  bookingUrl: string;
  /** Login del área de clientes (botón de pagar el primer pago). */
  portalUrl: string;
  /** «Hoy»: las fechas de ejemplo se cuentan desde aquí. */
  now: Date;
}

/** Nombre del inquilino ficticio de la vista previa. */
export function sampleCustomerName(locale: 'es' | 'en'): string {
  return locale === 'en' ? 'Alex' : 'Lucía';
}

const DAY_MS = 86_400_000;

const cents = (n: number): number => Math.round(n * 100) / 100;

/** El correo `kind` con datos de ejemplo (nada de esto sale de un inquilino real). */
export function sampleCustomerEmailData(
  kind: CustomerEmailKind,
  ctx: CustomerEmailSampleContext,
): CustomerEmailData {
  const en = ctx.locale === 'en';
  const at = (days: number) => new Date(ctx.now.getTime() + days * DAY_MS);
  const monthly = cents(ctx.monthlyWithVat);
  const deposit = cents(monthly);
  const unit = { unitCode: ctx.unitCode, facilityName: ctx.facilityName };
  const contract = { contractNumber: ctx.contractNumber, ...unit };

  switch (kind) {
    case 'invoice_issued':
      return {
        kind,
        invoiceNumber: ctx.invoiceNumber,
        total: monthly,
        dueDate: at(15),
        payment: { via: 'manual', transferIban: ctx.transferIban },
        pdfUrl: null,
      };
    case 'payment_received':
      return { kind, invoiceNumber: ctx.invoiceNumber, amount: monthly, paidAt: ctx.now };
    case 'payment_failed':
      return {
        kind,
        invoiceNumber: ctx.invoiceNumber,
        amount: monthly,
        reason: en ? 'Insufficient funds' : 'Fondos insuficientes',
      };
    case 'contract_signed':
      return {
        kind,
        ...contract,
        priceMonthly: monthly,
        startDate: at(3),
        directions: null,
      };
    case 'first_payment_pending':
      return {
        kind,
        ...contract,
        startDate: at(3),
        lines: [
          {
            description: en
              ? `Rent of storage unit ${ctx.unitCode}`
              : `Alquiler del trastero ${ctx.unitCode}`,
            amount: monthly,
          },
        ],
        deposit,
        total: cents(monthly + deposit),
        deadline: at(3),
        payUrl: ctx.portalUrl,
        pdfUrl: null,
      };
    case 'contract_ending_soon':
      return { kind, ...contract, endDate: at(30) };
    case 'contract_renewed':
      return { kind, ...contract, endDate: at(365), newPrice: null };
    case 'contract_auto_renewal_notice':
      return {
        kind,
        ...contract,
        endDate: at(30),
        newEndDate: at(395),
        months: 12,
        lastDayToCancel: at(15),
      };
    case 'contract_price_change':
      return {
        kind,
        ...contract,
        monthlyWithVat: cents(monthly * 1.03),
        effectiveDate: at(30),
        canLeaveWithoutNotice: true,
      };
    case 'deposit_settled':
      return {
        kind,
        contractNumber: ctx.contractNumber,
        unitCode: ctx.unitCode,
        deposit,
        returned: deposit,
        retained: 0,
        applied: 0,
        reason: null,
        service: null,
      };
    case 'move_out_confirmed':
      return { kind, ...contract, endDate: at(30) };
    case 'unit_request_resolved':
      return {
        kind,
        request: 'change',
        outcome: 'handled',
        note: en
          ? 'We have a larger unit available from the 1st of next month.'
          : 'Tenemos uno más grande libre a partir del día 1 del mes que viene.',
      };
    case 'reservation_held':
    case 'reservation_expiring':
      return {
        kind,
        ...unit,
        validUntil: at(kind === 'reservation_held' ? 7 : 2),
        signalDue: cents(monthly / 2),
      };
    case 'booking_expired':
      return {
        kind,
        ...unit,
        signed: true,
        invoiceCancelled: true,
        bookingUrl: ctx.bookingUrl,
      };
    case 'sepa_prenotification':
      return {
        kind,
        invoiceNumber: ctx.invoiceNumber,
        amount: monthly,
        collectionDate: at(14),
        ibanLast4: '1332',
        mandateReference: 'MND-EJEMPLO01',
        creditorName: ctx.creditorName,
        creditorId: ctx.creditorId,
      };
    case 'staff_message':
      return {
        kind,
        tenantName: ctx.tenantName,
        body: en
          ? 'Hi! Just to let you know that the lift on the ground floor will be under maintenance on Thursday morning.'
          : '¡Hola! Te escribimos para avisarte de que el jueves por la mañana el montacargas de la planta baja estará en mantenimiento.',
        viaEmail: false,
      };
  }
}
