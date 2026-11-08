import { randomBytes } from 'node:crypto';

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import {
  resolveCustomerEmailSettings,
  type AutomationTriggerValue,
  type CustomerEmailKind,
  type CustomerEmailSettingsDto,
  type UpdateCustomerEmailSettingsInput,
  replyAddressOf,
} from '@storageos/shared';

import { invoiceDownloadKey, invoiceDownloadUrl } from '../../common/invoice-download-token';
import { loadInvoicePaymentHint } from '../../common/invoice-payment-hint';
import { isPendingOnlineBookingInvoice } from '../../common/online-booking';
import { tenantBookingUrl, tenantPortalLoginUrl } from '../../common/portal-url';
import { tenantHasFeature } from '../../common/tenant-features';
import { claimAlert } from '../admin/alert-state';
import { AuditService } from '../auth/audit.service';
import {
  DOMAIN_EVENTS,
  type BookingExpiredPayload,
  type ContractDepositSettledPayload,
  type ContractPriceNoticePayload,
  type ContractRenewedPayload,
  type CustomerMessagePayload,
  type DomainEventPayload,
  type PaymentFailedPayload,
  type ReservationExpiringPayload,
  type SepaRemittanceCreatedPayload,
  type UnitRequestResolvedPayload,
} from '../automations/domain-events';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import {
  renderCustomerEmail,
  type CustomerEmailData,
  type InvoicePaymentHint,
} from './customer-emails.templates';

import type { Env } from '../../config/env.schema';
import type { Prisma } from '@storageos/database';

/** Como mucho un correo por mensajes del equipo cada 15 minutos por inquilino. */
const STAFF_MESSAGE_EMAIL_GAP_MINUTES = 15;

interface Recipient {
  customerId: string;
  email: string;
  name: string;
  /** Idioma del inquilino (`es` / `en`). */
  locale: string;
}

/**
 * Correos automáticos del tenant a sus inquilinos (activados por defecto,
 * cada uno se puede apagar en Ajustes → Correo). Salen por el outbox de
 * comunicaciones con el remitente del tenant, quedan en /communications
 * enlazados a su factura o contrato, y nunca rompen el flujo que los origina.
 *
 * Si el tenant ya tiene una automatización activa para el mismo evento, el
 * correo por defecto no se envía (para no mandar dos).
 */
/** Qué pasó con un correo al inquilino (el preaviso SEPA lo anota en la remesa). */
type SendOutcome =
  | { status: 'sent'; communicationId: string; recipient: string; subject: string; text: string }
  | { status: 'disabled' | 'automation' | 'no_email' | 'failed' };

/** Van al email de facturación si la empresa tiene uno. */
const BILLING_KINDS = new Set<string>(['invoice_issued', 'payment_received', 'payment_failed']);

@Injectable()
export class CustomerEmailsService {
  private readonly logger = new Logger(CustomerEmailsService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly communications: CommunicationsService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // -------------------------------------------------------------------------
  // Ajustes
  // -------------------------------------------------------------------------

  async getSettings(tenantId: string): Promise<CustomerEmailSettingsDto> {
    const t = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { customerEmailSettings: true },
    });
    return resolveCustomerEmailSettings(t?.customerEmailSettings);
  }

  async updateSettings(
    tenantId: string,
    userId: string,
    input: UpdateCustomerEmailSettingsInput,
  ): Promise<CustomerEmailSettingsDto> {
    const current = await this.getSettings(tenantId);
    const next: CustomerEmailSettingsDto = { ...current };
    for (const [k, v] of Object.entries(input)) {
      if (typeof v === 'boolean') next[k as CustomerEmailKind] = v;
    }
    // Solo se guardan los apagados: un tipo nuevo nace activado.
    const stored = Object.fromEntries(
      Object.entries(next)
        .filter(([, on]) => !on)
        .map(([k]) => [k, false]),
    );
    await this.admin.tenant.update({
      where: { id: tenantId },
      data: { customerEmailSettings: stored as Prisma.InputJsonValue },
    });
    await this.audit.write({
      tenantId,
      userId,
      action: 'tenant.customer_emails.settings_changed',
      entityType: 'Tenant',
      entityId: tenantId,
      changes: input,
    });
    return next;
  }

  // -------------------------------------------------------------------------
  // Listeners
  // -------------------------------------------------------------------------

  @OnEvent(DOMAIN_EVENTS.invoice_issued, { async: true, promisify: true })
  async onInvoiceIssued(p: DomainEventPayload): Promise<void> {
    await this.safe('invoice_issued', p.tenantId, async () => {
      const inv = await this.invoice(p.tenantId, p.entityId);
      // Rectificativas (importe negativo) y facturas a 0 € no se avisan. Las de
      // suscripción (negocio propio → tenant) ya llevan el correo de la plataforma.
      if (!inv?.customerId || Number(inv.total) <= 0 || inv.platformPaymentId) return;
      // La primera de una reserva online se paga en la propia reserva y, si no
      // se paga, se anula: la factura le llega con el justificante del pago.
      if (await isPendingOnlineBookingInvoice(this.admin, p.tenantId, p.entityId, inv.contractId)) {
        return;
      }
      await this.send(p.tenantId, 'invoice_issued', 'invoice_issued', inv.customerId, {
        data: {
          kind: 'invoice_issued',
          invoiceNumber: inv.invoiceNumber,
          // Con retención de IRPF, lo que hay que pagar (total − retención).
          total: Number(inv.total) - Number(inv.withholdingAmount),
          dueDate: inv.dueDate,
          payment: await this.paymentHint(p.tenantId, inv.customerId),
          pdfUrl: this.pdfUrl(p.tenantId, p.entityId),
        },
        invoiceId: p.entityId,
        contractId: inv.contractId,
      });
    });
  }

  /** Reserva online cancelada por no pagarse a tiempo: se le avisa y se le ofrece volver. */
  @OnEvent(DOMAIN_EVENTS.booking_expired, { async: true, promisify: true })
  async onBookingExpired(p: BookingExpiredPayload): Promise<void> {
    await this.safe('booking_expired', p.tenantId, async () => {
      const [contract, tenant, voided] = await Promise.all([
        this.admin.contract.findFirst({
          where: { id: p.contractId, tenantId: p.tenantId },
          select: {
            signedAt: true,
            unit: {
              select: {
                code: true,
                unitTypeId: true,
                facility: { select: { id: true, name: true } },
              },
            },
          },
        }),
        this.admin.tenant.findUnique({
          where: { id: p.tenantId },
          select: { slug: true, customDomain: true, customDomainVerifiedAt: true },
        }),
        // Factura ya numerada que se ha anulado con su rectificativa.
        this.admin.invoice.count({
          where: {
            tenantId: p.tenantId,
            contractId: p.contractId,
            kind: 'invoice',
            status: 'rectified',
          },
        }),
      ]);
      if (!contract || !tenant) return;
      await this.send(p.tenantId, 'booking_expired', null, p.customerId, {
        data: {
          kind: 'booking_expired',
          unitCode: contract.unit.code,
          facilityName: contract.unit.facility.name,
          signed: contract.signedAt !== null,
          invoiceCancelled: voided > 0,
          bookingUrl: tenantBookingUrl(this.config.get('WEB_BASE_URL', { infer: true }), tenant, {
            facilityId: contract.unit.facility.id,
            unitTypeId: contract.unit.unitTypeId,
          }),
        },
        contractId: p.contractId,
      });
    });
  }

  @OnEvent(DOMAIN_EVENTS.invoice_paid, { async: true, promisify: true })
  async onInvoicePaid(p: DomainEventPayload): Promise<void> {
    await this.safe('payment_received', p.tenantId, async () => {
      // Saldada con un abono (no con un cobro): no hay «pago recibido».
      const scopeInvoice = (p.scope as { invoice?: { compensated?: boolean } } | undefined)
        ?.invoice;
      if (scopeInvoice?.compensated) return;
      const inv = await this.invoice(p.tenantId, p.entityId);
      if (!inv?.customerId || Number(inv.total) <= 0 || inv.platformPaymentId) return;
      // Con su justificante de fianza cobrado en el mismo pago: un solo aviso
      // por el importe total pagado.
      const receipts = await this.admin.invoice.findMany({
        where: {
          tenantId: p.tenantId,
          bundledWithInvoiceId: p.entityId,
          status: 'paid',
          deletedAt: null,
        },
        select: { total: true },
      });
      const amount = receipts.reduce(
        (sum, r) => sum + Number(r.total),
        Number(inv.total) - Number(inv.withholdingAmount),
      );
      await this.send(p.tenantId, 'payment_received', 'invoice_paid', inv.customerId, {
        data: {
          kind: 'payment_received',
          invoiceNumber: inv.invoiceNumber,
          amount: Math.round(amount * 100) / 100,
          paidAt: inv.paidAt ?? new Date(),
          depositReceipt: inv.kind === 'deposit_receipt',
          ...(inv.kind === 'invoice' ? { pdfUrl: this.pdfUrl(p.tenantId, p.entityId) } : {}),
        },
        invoiceId: p.entityId,
        contractId: inv.contractId,
      });
    });
  }

  @OnEvent(DOMAIN_EVENTS.payment_failed, { async: true, promisify: true })
  async onPaymentFailed(p: PaymentFailedPayload): Promise<void> {
    await this.safe('payment_failed', p.tenantId, async () => {
      if (!p.customerId) return;
      const inv = await this.invoice(p.tenantId, p.invoiceId);
      // Si entretanto se pagó (p. ej. con otro método), no se avisa.
      if (!inv || inv.status === 'paid' || inv.status === 'cancelled') return;
      await this.send(p.tenantId, 'payment_failed', null, p.customerId, {
        data: {
          kind: 'payment_failed',
          invoiceNumber: inv.invoiceNumber,
          amount: p.amount,
          reason: p.reason,
        },
        invoiceId: p.invoiceId,
        contractId: inv.contractId,
      });
    });
  }

  @OnEvent(DOMAIN_EVENTS.contract_signed, { async: true, promisify: true })
  async onContractSigned(p: DomainEventPayload): Promise<void> {
    await this.safe('contract_signed', p.tenantId, async () => {
      const c = await this.contract(p.tenantId, p.entityId);
      if (!c) return;
      await this.send(p.tenantId, 'contract_signed', 'contract_signed', c.customerId, {
        data: {
          kind: 'contract_signed',
          contractNumber: c.contractNumber,
          unitCode: c.unit.code,
          facilityName: c.unit.facility.name,
          priceMonthly: Number(c.priceMonthly),
          startDate: c.startDate,
          // Reserva antes de la apertura: empieza el día que abre el local.
          preOpening:
            c.preOpening && !c.preOpeningStartedAt
              ? { openingDate: c.preOpeningDateConfirmed ? c.startDate : null }
              : null,
          directions: c.unit.facility.directions,
        },
        contractId: c.id,
      });
    });
  }

  @OnEvent(DOMAIN_EVENTS.contract_ending_soon, { async: true, promisify: true })
  async onContractEndingSoon(p: DomainEventPayload): Promise<void> {
    await this.safe('contract_ending_soon', p.tenantId, async () => {
      const c = await this.contract(p.tenantId, p.entityId);
      // Con baja ya pedida o renovación automática, el aviso no aplica.
      if (!c?.endDate || c.status !== 'active' || c.autoRenew) return;
      await this.send(p.tenantId, 'contract_ending_soon', 'contract_ending_soon', c.customerId, {
        data: {
          kind: 'contract_ending_soon',
          contractNumber: c.contractNumber,
          unitCode: c.unit.code,
          facilityName: c.unit.facility.name,
          endDate: c.endDate,
        },
        contractId: c.id,
      });
    });
  }

  @OnEvent(DOMAIN_EVENTS.contract_renewed, { async: true, promisify: true })
  async onContractRenewed(p: ContractRenewedPayload): Promise<void> {
    await this.safe('contract_renewed', p.tenantId, async () => {
      const c = await this.contract(p.tenantId, p.contractId);
      if (!c) return;
      await this.send(p.tenantId, 'contract_renewed', null, c.customerId, {
        data: {
          kind: 'contract_renewed',
          contractNumber: c.contractNumber,
          unitCode: c.unit.code,
          facilityName: c.unit.facility.name,
          endDate: p.newEndDate,
        },
        contractId: c.id,
      });
    });
  }

  @OnEvent(DOMAIN_EVENTS.contract_price_notice, { async: true, promisify: true })
  async onContractPriceNotice(p: ContractPriceNoticePayload): Promise<void> {
    await this.safe('contract_price_change', p.tenantId, async () => {
      const c = await this.contract(p.tenantId, p.contractId);
      if (!c) return;
      await this.send(p.tenantId, 'contract_price_change', null, c.customerId, {
        data: {
          kind: 'contract_price_change',
          contractNumber: c.contractNumber,
          unitCode: c.unit.code,
          facilityName: c.unit.facility.name,
          monthlyWithVat: p.monthlyWithVat,
          effectiveDate: p.effectiveDate,
        },
        contractId: c.id,
      });
    });
  }

  @OnEvent(DOMAIN_EVENTS.contract_deposit_settled, { async: true, promisify: true })
  async onDepositSettled(p: ContractDepositSettledPayload): Promise<void> {
    await this.safe('deposit_settled', p.tenantId, async () => {
      const c = await this.contract(p.tenantId, p.contractId);
      if (!c) return;
      await this.send(p.tenantId, 'deposit_settled', null, c.customerId, {
        data: {
          kind: 'deposit_settled',
          contractNumber: c.contractNumber,
          unitCode: c.unit.code,
          deposit: p.deposit,
          returned: p.returned,
          retained: p.retained,
          applied: p.applied,
          reason: p.reason,
        },
        contractId: c.id,
      });
    });
  }

  @OnEvent(DOMAIN_EVENTS.contract_move_out_requested, { async: true, promisify: true })
  async onMoveOutRequested(p: DomainEventPayload): Promise<void> {
    await this.safe('move_out_confirmed', p.tenantId, async () => {
      const c = await this.contract(p.tenantId, p.entityId);
      if (!c?.endDate) return;
      await this.send(p.tenantId, 'move_out_confirmed', null, c.customerId, {
        data: {
          kind: 'move_out_confirmed',
          contractNumber: c.contractNumber,
          unitCode: c.unit.code,
          facilityName: c.unit.facility.name,
          endDate: c.endDate,
        },
        contractId: c.id,
      });
    });
  }

  @OnEvent(DOMAIN_EVENTS.reservation_confirmed, { async: true, promisify: true })
  async onReservationConfirmed(p: DomainEventPayload): Promise<void> {
    await this.safe('reservation_held', p.tenantId, async () => {
      await this.sendReservation(p.tenantId, p.entityId, 'reservation_held');
    });
  }

  @OnEvent(DOMAIN_EVENTS.reservation_expiring, { async: true, promisify: true })
  async onReservationExpiring(p: ReservationExpiringPayload): Promise<void> {
    await this.safe('reservation_expiring', p.tenantId, async () => {
      await this.sendReservation(p.tenantId, p.reservationId, 'reservation_expiring');
    });
  }

  private async sendReservation(
    tenantId: string,
    reservationId: string,
    kind: 'reservation_held' | 'reservation_expiring',
  ): Promise<void> {
    const r = await this.admin.reservation.findFirst({
      where: { id: reservationId, tenantId },
      include: { unit: { select: { code: true, facility: { select: { name: true } } } } },
    });
    if (!r?.customerId) return;
    await this.send(
      tenantId,
      kind,
      kind === 'reservation_held' ? 'reservation_confirmed' : null,
      r.customerId,
      {
        data: {
          kind,
          unitCode: r.unit.code,
          facilityName: r.unit.facility.name,
          validUntil: r.validUntil,
          signalDue: r.depositPaid ? 0 : Number(r.depositAmount),
        },
      },
    );
  }

  @OnEvent(DOMAIN_EVENTS.unit_request_resolved, { async: true, promisify: true })
  async onUnitRequestResolved(p: UnitRequestResolvedPayload): Promise<void> {
    await this.safe('unit_request_resolved', p.tenantId, async () => {
      await this.send(p.tenantId, 'unit_request_resolved', null, p.customerId, {
        data: {
          kind: 'unit_request_resolved',
          request: p.request,
          outcome: p.outcome,
          note: p.note,
        },
        ...(p.contractId ? { contractId: p.contractId } : {}),
      });
    });
  }

  /**
   * El equipo escribe al inquilino en «Mensajes»: copia por correo (el push solo
   * llega a quien lo activó). Como mucho una cada 15 minutos por inquilino: si
   * el equipo escribe varias frases seguidas, basta el primer aviso.
   */
  @OnEvent(DOMAIN_EVENTS.customer_message_from_staff, { async: true, promisify: true })
  async onStaffMessage(p: CustomerMessagePayload): Promise<void> {
    await this.safe('staff_message', p.tenantId, async () => {
      // Escribió por WhatsApp (en las últimas 24 h): la respuesta sale por WhatsApp.
      if (p.replyVia === 'whatsapp' && (await this.replyByWhatsapp(p))) return;
      // Escribió por email: cada respuesta sale por email (es la conversación).
      if (p.replyVia === 'email') {
        const tenant = await this.admin.tenant.findUnique({
          where: { id: p.tenantId },
          select: { name: true },
        });
        if (!tenant) return;
        const replyTo = await this.conversationReplyAddress(p.tenantId, p.customerId);
        await this.send(p.tenantId, 'staff_message', null, p.customerId, {
          data: {
            kind: 'staff_message',
            tenantName: tenant.name,
            body: p.body,
            viaEmail: replyTo !== null,
          },
          ignoreSettings: true,
          ...(replyTo ? { replyTo } : {}),
        });
        return;
      }
      // El plazo cuenta desde el último correo, no desde el último mensaje.
      const claimed = await claimAlert(
        this.admin,
        'customer_message_email',
        p.customerId,
        STAFF_MESSAGE_EMAIL_GAP_MINUTES,
      );
      if (!claimed) return;
      const tenant = await this.admin.tenant.findUnique({
        where: { id: p.tenantId },
        select: { name: true },
      });
      if (!tenant) return;
      const replyTo = await this.conversationReplyAddress(p.tenantId, p.customerId);
      await this.send(p.tenantId, 'staff_message', null, p.customerId, {
        data: {
          kind: 'staff_message',
          tenantName: tenant.name,
          body: p.body,
          viaEmail: replyTo !== null,
        },
        ...(replyTo ? { replyTo } : {}),
      });
    });
  }

  /** Dirección propia de la conversación: lo que se conteste al correo vuelve al hilo. */
  private async conversationReplyAddress(
    tenantId: string,
    customerId: string,
  ): Promise<string | null> {
    const domain = this.config.get('INBOUND_EMAIL_DOMAIN', { infer: true });
    if (!domain) return null;
    const row = await this.admin.customerConversation.upsert({
      where: { customerId },
      create: {
        customerId,
        tenantId,
        status: 'answered',
        replyToken: randomBytes(16).toString('hex'),
      },
      update: {},
    });
    const token =
      row.replyToken ??
      (
        await this.admin.customerConversation.update({
          where: { customerId },
          data: { replyToken: randomBytes(16).toString('hex') },
        })
      ).replyToken!;
    return replyAddressOf('c', token, domain);
  }

  /** Respuesta por el WhatsApp de la plataforma. `false` si no se puede (sigue el correo). */
  private async replyByWhatsapp(p: CustomerMessagePayload): Promise<boolean> {
    if (!this.communications.whatsappAvailable) return false;
    const c = await this.admin.customer.findFirst({
      where: { id: p.customerId, tenantId: p.tenantId, deletedAt: null },
      select: { phone: true },
    });
    if (!c?.phone) return false;
    await this.communications.enqueue({
      tenantId: p.tenantId,
      channel: 'whatsapp',
      recipient: c.phone,
      bodyText: p.body,
      customerId: p.customerId,
      source: 'customer_message.reply',
    });
    return true;
  }

  /** Preaviso SEPA: un correo por adeudo de la remesa, a su deudor. */
  @OnEvent(DOMAIN_EVENTS.sepa_remittance_created, { async: true, promisify: true })
  async onSepaRemittanceCreated(p: SepaRemittanceCreatedPayload): Promise<void> {
    await this.safe('sepa_prenotification', p.tenantId, async () => {
      const remittance = await this.admin.sepaRemittance.findFirst({
        where: { id: p.remittanceId, tenantId: p.tenantId },
        select: {
          collectionDate: true,
          items: {
            select: {
              invoiceId: true,
              amount: true,
              invoice: { select: { invoiceNumber: true, contractId: true } },
              mandate: { select: { customerId: true, reference: true, ibanLast4: true } },
            },
          },
        },
      });
      const settings = await this.admin.sepaSettings.findUnique({
        where: { tenantId: p.tenantId },
        select: { creditorName: true, creditorId: true },
      });
      if (!remittance || !settings) return;
      for (const item of remittance.items) {
        let outcome: SendOutcome;
        try {
          outcome = await this.send(
            p.tenantId,
            'sepa_prenotification',
            null,
            item.mandate.customerId,
            {
              data: {
                kind: 'sepa_prenotification',
                invoiceNumber: item.invoice.invoiceNumber,
                // La remesa guarda el importe en céntimos.
                amount: Number(item.amount) / 100,
                collectionDate: remittance.collectionDate,
                ibanLast4: item.mandate.ibanLast4,
                mandateReference: item.mandate.reference,
                creditorName: settings.creditorName,
                creditorId: settings.creditorId,
              },
              invoiceId: item.invoiceId,
              contractId: item.invoice.contractId,
            },
          );
        } catch (err) {
          this.logger.warn(
            `[customer-email sepa_prenotification] tenant=${p.tenantId}: ${err instanceof Error ? err.message : err}`,
          );
          outcome = { status: 'failed' };
        }
        await this.recordPrenotice(p.tenantId, p.remittanceId, item.invoiceId, outcome);
      }
    });
  }

  /**
   * Constancia del preaviso en el adeudo de la remesa (dura lo que la remesa,
   * no lo que el correo en Comunicaciones): prueba ante una devolución.
   */
  private async recordPrenotice(
    tenantId: string,
    remittanceId: string,
    invoiceId: string,
    outcome: SendOutcome,
  ): Promise<void> {
    await this.admin.sepaRemittanceItem.updateMany({
      // Solo el adeudo de ESTA remesa: la constancia de una remesa anterior de
      // la misma factura (devuelta o rechazada) no se pisa.
      where: { tenantId, remittanceId, invoiceId },
      data:
        outcome.status === 'sent'
          ? {
              prenoticeStatus: 'sent',
              prenoticeAt: new Date(),
              prenoticeRecipient: outcome.recipient,
              prenoticeSubject: outcome.subject,
              prenoticeText: outcome.text,
              prenoticeCommunicationId: outcome.communicationId,
            }
          : { prenoticeStatus: outcome.status, prenoticeAt: new Date() },
    });
  }

  // -------------------------------------------------------------------------
  // Internos
  // -------------------------------------------------------------------------

  private async send(
    tenantId: string,
    kind: CustomerEmailKind,
    /** Disparador de automatizaciones equivalente (para no duplicar), si lo hay. */
    trigger: AutomationTriggerValue | null,
    customerId: string,
    args: {
      data: CustomerEmailData;
      invoiceId?: string;
      contractId?: string | null;
      /** La respuesta a quien escribió por email sale aunque las copias estén apagadas. */
      ignoreSettings?: boolean;
      /** Lo que se conteste a este correo vuelve a la conversación. */
      replyTo?: string;
    },
  ): Promise<SendOutcome> {
    const settings = await this.getSettings(tenantId);
    if (!settings[kind] && !args.ignoreSettings) return { status: 'disabled' };
    if (trigger && (await this.hasActiveAutomation(tenantId, trigger))) {
      return { status: 'automation' };
    }

    const recipient = await this.recipient(tenantId, customerId, BILLING_KINDS.has(kind));
    if (!recipient) return { status: 'no_email' };
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: {
        name: true,
        slug: true,
        customDomain: true,
        customDomainVerifiedAt: true,
        portalLogoUrl: true,
        portalBrandColor: true,
      },
    });
    if (!tenant) return { status: 'failed' };

    const email = renderCustomerEmail(
      {
        tenantName: tenant.name,
        customerName: recipient.name,
        locale: recipient.locale,
        logoUrl: tenant.portalLogoUrl,
        brandColor: tenant.portalBrandColor,
        portalUrl: tenantPortalLoginUrl(this.config.get('WEB_BASE_URL', { infer: true }), tenant),
      },
      args.data,
    );
    const comm = await this.communications.enqueue({
      tenantId,
      channel: 'email',
      recipient: recipient.email,
      subject: email.subject,
      bodyText: email.text,
      bodyHtml: email.html,
      customerId,
      ...(args.invoiceId ? { invoiceId: args.invoiceId } : {}),
      ...(args.contractId ? { contractId: args.contractId } : {}),
      source: `customer_email.${kind}`,
      ...(args.replyTo ? { replyTo: args.replyTo } : {}),
    });
    return {
      status: 'sent',
      communicationId: comm.id,
      recipient: recipient.email,
      subject: email.subject,
      text: email.text,
    };
  }

  private async hasActiveAutomation(
    tenantId: string,
    trigger: AutomationTriggerValue,
  ): Promise<boolean> {
    const rules = await this.admin.automationRule.count({
      where: { tenantId, trigger, isActive: true, actionType: 'send_email' },
    });
    // Las reglas solo se ejecutan con la funcionalidad en el plan.
    return rules > 0 && (await tenantHasFeature(this.admin, tenantId, 'automations'));
  }

  /**
   * Copia de una factura que el equipo envía a mano (o reenvía) desde su ficha.
   * Sale aunque los correos automáticos de facturas estén apagados.
   */
  async sendInvoiceCopy(args: {
    tenantId: string;
    invoiceId: string;
    /** Otro email; por defecto el de facturación del inquilino o el suyo. */
    email?: string;
  }): Promise<{ communicationId: string; recipient: string }> {
    const inv = await this.admin.invoice.findFirst({
      where: { id: args.invoiceId, tenantId: args.tenantId, deletedAt: null },
      select: {
        customerId: true,
        invoiceNumber: true,
        status: true,
        total: true,
        withholdingAmount: true,
        dueDate: true,
        paidAt: true,
        contractId: true,
      },
    });
    if (!inv?.customerId) {
      throw new BadRequestException({
        code: 'customer_email_missing',
        message: 'La factura no tiene un cliente al que enviarla',
      });
    }
    const customer = await this.admin.customer.findFirst({
      where: { id: inv.customerId, tenantId: args.tenantId },
      select: {
        email: true,
        billingEmail: true,
        firstName: true,
        companyName: true,
        customerType: true,
        locale: true,
      },
    });
    const email = args.email ?? customer?.billingEmail ?? customer?.email;
    if (!email) {
      throw new BadRequestException({
        code: 'customer_email_missing',
        message: 'El inquilino no tiene email: escribe a cuál enviarla',
      });
    }
    const tenant = await this.admin.tenant.findUniqueOrThrow({
      where: { id: args.tenantId },
      select: {
        name: true,
        slug: true,
        customDomain: true,
        customDomainVerifiedAt: true,
        portalLogoUrl: true,
        portalBrandColor: true,
      },
    });
    const paid = inv.status === 'paid';
    const pending = inv.status === 'issued' || inv.status === 'overdue';
    const rendered = renderCustomerEmail(
      {
        tenantName: tenant.name,
        customerName:
          (customer?.customerType === 'business' ? customer.companyName : customer?.firstName) ??
          '',
        locale: customer?.locale ?? null,
        logoUrl: tenant.portalLogoUrl,
        brandColor: tenant.portalBrandColor,
        portalUrl: tenantPortalLoginUrl(this.config.get('WEB_BASE_URL', { infer: true }), tenant),
      },
      {
        kind: 'invoice_copy',
        invoiceNumber: inv.invoiceNumber,
        total: Number(inv.total) - Number(inv.withholdingAmount),
        dueDate: pending ? inv.dueDate : null,
        paidAt: paid ? (inv.paidAt ?? null) : null,
        payment: pending ? await this.paymentHint(args.tenantId, inv.customerId) : null,
        pdfUrl: this.pdfUrl(args.tenantId, args.invoiceId),
      },
    );
    const comm = await this.communications.enqueue({
      tenantId: args.tenantId,
      channel: 'email',
      recipient: email,
      subject: rendered.subject,
      bodyText: rendered.text,
      bodyHtml: rendered.html,
      customerId: inv.customerId,
      invoiceId: args.invoiceId,
      ...(inv.contractId ? { contractId: inv.contractId } : {}),
      source: 'invoice.sent',
    });
    return { communicationId: comm.id, recipient: email };
  }

  private async recipient(
    tenantId: string,
    customerId: string,
    billing = false,
  ): Promise<Recipient | null> {
    const c = await this.admin.customer.findFirst({
      where: { id: customerId, tenantId, deletedAt: null },
      select: {
        email: true,
        billingEmail: true,
        firstName: true,
        companyName: true,
        customerType: true,
        locale: true,
      },
    });
    const email = (billing ? c?.billingEmail : null) ?? c?.email;
    if (!c || !email) return null;
    const name = (c.customerType === 'business' ? c.companyName : c.firstName) ?? '';
    return { customerId, email, name, locale: c.locale };
  }

  /**
   * Cómo se pagará: cobro automático al emitir (si el tenant lo tiene y el
   * inquilino tiene tarjeta o domiciliación por pasarela), remesa SEPA (mandato
   * activo) o a mano (área de clientes + IBAN para transferencias si lo hay).
   */
  private paymentHint(tenantId: string, customerId: string): Promise<InvoicePaymentHint> {
    return loadInvoicePaymentHint(this.admin, tenantId, customerId);
  }

  /** Descarga de la factura sin iniciar sesión (enlace firmado). */
  private pdfUrl(tenantId: string, invoiceId: string): string {
    return invoiceDownloadUrl(
      this.config.get('API_BASE_URL', { infer: true }),
      invoiceDownloadKey(this.config.get('MASTER_ENCRYPTION_KEY', { infer: true })),
      tenantId,
      invoiceId,
    );
  }

  private invoice(tenantId: string, invoiceId: string) {
    return this.admin.invoice.findFirst({
      where: { id: invoiceId, tenantId },
      select: {
        status: true,
        kind: true,
        invoiceNumber: true,
        total: true,
        withholdingAmount: true,
        dueDate: true,
        paidAt: true,
        customerId: true,
        contractId: true,
        platformPaymentId: true,
      },
    });
  }

  private contract(tenantId: string, contractId: string) {
    return this.admin.contract.findFirst({
      where: { id: contractId, tenantId, deletedAt: null },
      select: {
        id: true,
        customerId: true,
        contractNumber: true,
        status: true,
        autoRenew: true,
        priceMonthly: true,
        startDate: true,
        endDate: true,
        preOpening: true,
        preOpeningDateConfirmed: true,
        preOpeningStartedAt: true,
        unit: {
          select: { code: true, facility: { select: { name: true, directions: true } } },
        },
      },
    });
  }

  /** Un fallo al avisar nunca rompe la factura, el pago o el contrato. */
  private async safe(kind: CustomerEmailKind, tenantId: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      this.logger.warn(
        `[customer-email ${kind}] tenant=${tenantId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
