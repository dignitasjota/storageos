import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import {
  resolveCustomerEmailSettings,
  type AutomationTriggerValue,
  type CustomerEmailKind,
  type CustomerEmailSettingsDto,
  type UpdateCustomerEmailSettingsInput,
} from '@storageos/shared';

import { tenantPortalLoginUrl } from '../../common/portal-url';
import { tenantHasFeature } from '../../common/tenant-features';
import { AuditService } from '../auth/audit.service';
import {
  DOMAIN_EVENTS,
  type DomainEventPayload,
  type PaymentFailedPayload,
  type SepaRemittanceCreatedPayload,
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
      // Rectificativas (importe negativo) y facturas a 0 € no se avisan.
      if (!inv?.customerId || Number(inv.total) <= 0) return;
      await this.send(p.tenantId, 'invoice_issued', 'invoice_issued', inv.customerId, {
        data: {
          kind: 'invoice_issued',
          invoiceNumber: inv.invoiceNumber,
          total: Number(inv.total),
          dueDate: inv.dueDate,
          payment: await this.paymentHint(p.tenantId, inv.customerId),
        },
        invoiceId: p.entityId,
        contractId: inv.contractId,
      });
    });
  }

  @OnEvent(DOMAIN_EVENTS.invoice_paid, { async: true, promisify: true })
  async onInvoicePaid(p: DomainEventPayload): Promise<void> {
    await this.safe('payment_received', p.tenantId, async () => {
      const inv = await this.invoice(p.tenantId, p.entityId);
      if (!inv?.customerId || Number(inv.total) <= 0) return;
      await this.send(p.tenantId, 'payment_received', 'invoice_paid', inv.customerId, {
        data: {
          kind: 'payment_received',
          invoiceNumber: inv.invoiceNumber,
          amount: Number(inv.total),
          paidAt: inv.paidAt ?? new Date(),
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
        await this.recordPrenotice(p.tenantId, item.invoiceId, outcome);
      }
    });
  }

  /**
   * Constancia del preaviso en el adeudo de la remesa (dura lo que la remesa,
   * no lo que el correo en Comunicaciones): prueba ante una devolución.
   */
  private async recordPrenotice(
    tenantId: string,
    invoiceId: string,
    outcome: SendOutcome,
  ): Promise<void> {
    await this.admin.sepaRemittanceItem.updateMany({
      where: { tenantId, invoiceId },
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
    args: { data: CustomerEmailData; invoiceId?: string; contractId?: string | null },
  ): Promise<SendOutcome> {
    const settings = await this.getSettings(tenantId);
    if (!settings[kind]) return { status: 'disabled' };
    if (trigger && (await this.hasActiveAutomation(tenantId, trigger))) {
      return { status: 'automation' };
    }

    const recipient = await this.recipient(tenantId, customerId);
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

  private async recipient(tenantId: string, customerId: string): Promise<Recipient | null> {
    const c = await this.admin.customer.findFirst({
      where: { id: customerId, tenantId, deletedAt: null },
      select: {
        email: true,
        firstName: true,
        companyName: true,
        customerType: true,
        locale: true,
      },
    });
    if (!c?.email) return null;
    const name = (c.customerType === 'business' ? c.companyName : c.firstName) ?? '';
    return { customerId, email: c.email, name, locale: c.locale };
  }

  /**
   * Cómo se pagará: cobro automático al emitir (si el tenant lo tiene y el
   * inquilino tiene tarjeta o domiciliación por pasarela), remesa SEPA (mandato
   * activo) o a mano (área de clientes + IBAN para transferencias si lo hay).
   */
  private async paymentHint(tenantId: string, customerId: string): Promise<InvoicePaymentHint> {
    const [tenant, pm, mandate] = await Promise.all([
      this.admin.tenant.findUnique({
        where: { id: tenantId },
        select: { autoChargeOnIssue: true, transferIban: true },
      }),
      this.admin.paymentMethod.findFirst({
        where: {
          tenantId,
          customerId,
          isDefault: true,
          deletedAt: null,
          type: { in: ['card', 'sepa_debit'] },
        },
        select: { type: true, brand: true, last4: true },
      }),
      this.admin.sepaMandate.findFirst({
        where: { tenantId, customerId, status: 'active' },
        select: { ibanLast4: true },
      }),
    ]);
    if (tenant?.autoChargeOnIssue && pm) {
      return pm.type === 'card'
        ? { via: 'auto_card', brand: pm.brand, last4: pm.last4 }
        : { via: 'auto_debit', last4: pm.last4 };
    }
    if (mandate) return { via: 'sepa_remittance', last4: mandate.ibanLast4 };
    return { via: 'manual', transferIban: tenant?.transferIban ?? null };
  }

  private invoice(tenantId: string, invoiceId: string) {
    return this.admin.invoice.findFirst({
      where: { id: invoiceId, tenantId },
      select: {
        status: true,
        invoiceNumber: true,
        total: true,
        dueDate: true,
        paidAt: true,
        customerId: true,
        contractId: true,
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
        unit: { select: { code: true, facility: { select: { name: true } } } },
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
