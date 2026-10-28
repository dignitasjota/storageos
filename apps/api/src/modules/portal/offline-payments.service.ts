import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  OFFLINE_PAYMENT_EXTRA_HOURS,
  type OfflinePaymentMethodValue,
  type PortalOfflinePaymentInput,
  type PortalOfflinePaymentResultDto,
  type PortalPaymentOptionsDto,
} from '@storageos/shared';

import { emailLocale, formatDateLong, formatEur, type EmailLocale } from '../../common/format';
import { tenantHasFeature } from '../../common/tenant-features';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SepaService } from '../sepa/sepa.service';

const HOUR_MS = 3_600_000;
/** Transferencia y pago en el local no tienen cobro en marcha: amplían el plazo una vez. */
const EXTENDS_HOLD: readonly OfflinePaymentMethodValue[] = ['bank_transfer', 'cash'];

const STAFF_TITLE: Record<OfflinePaymentMethodValue, string> = {
  bank_transfer: 'pagará por transferencia',
  cash: 'pagará en el local',
  sepa_debit: 'pagará por domiciliación',
};

/**
 * Formas de pago sin pasarela que el inquilino elige al reservar o pagar una
 * factura: transferencia (le llega el IBAN por correo), en el local o
 * domiciliación con la remesa SEPA del negocio. Cada una la activa el tenant.
 * El equipo recibe un aviso y marca la factura pagada al recibir el dinero.
 */
@Injectable()
export class OfflinePaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly communications: CommunicationsService,
    private readonly notifications: NotificationsService,
    private readonly sepa: SepaService,
  ) {}

  /** Qué formas sin pasarela ofrece el negocio (la tarjeta la resuelve el portal). */
  async options(tenantId: string): Promise<Omit<PortalPaymentOptionsDto, 'cardPayments'>> {
    const [tenant, sepa] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.tenant.findUnique({
            where: { id: tenantId },
            select: {
              transferIban: true,
              offlineTransferEnabled: true,
              offlineCashEnabled: true,
              offlineSepaEnabled: true,
            },
          }),
          tx.sepaSettings.findUnique({
            where: { tenantId },
            select: {
              enabled: true,
              creditorAddress: true,
              creditorPostalCode: true,
              creditorCity: true,
            },
          }),
        ]),
      tenantId,
    );
    const sepaWanted = !!tenant?.offlineSepaEnabled && !!sepa?.enabled;
    return {
      bankTransfer: !!tenant?.offlineTransferEnabled && !!tenant.transferIban,
      payAtFacility: !!tenant?.offlineCashEnabled,
      sepaDebit:
        sepaWanted &&
        // Las remesas SEPA van por plan: tras bajar de plan deja de ofrecerse.
        (await tenantHasFeature(this.admin, tenantId, 'sepa')) &&
        !!sepa?.enabled &&
        !!sepa.creditorAddress &&
        !!sepa.creditorPostalCode &&
        !!sepa.creditorCity,
    };
  }

  async choose(
    tenantId: string,
    customerId: string,
    invoiceId: string,
    input: PortalOfflinePaymentInput,
  ): Promise<PortalOfflinePaymentResultDto> {
    const invoice = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findFirst({
          where: { id: invoiceId, tenantId, customerId, kind: 'invoice', deletedAt: null },
          select: {
            id: true,
            invoiceNumber: true,
            status: true,
            total: true,
            amountPaid: true,
            contract: {
              select: {
                id: true,
                status: true,
                firstPaymentDeadline: true,
                offlinePaymentMethod: true,
              },
            },
            // La fianza que se paga junto a esta factura.
            bundledReceipts: {
              where: { status: { in: ['issued', 'overdue'] }, deletedAt: null },
              select: { invoiceNumber: true, total: true, amountPaid: true },
            },
            customer: {
              select: {
                email: true,
                firstName: true,
                lastName: true,
                companyName: true,
                locale: true,
              },
            },
          },
        }),
      tenantId,
    );
    if (!invoice) {
      throw new NotFoundException({ code: 'invoice_not_found', message: 'Factura no encontrada' });
    }
    const pending =
      Number(invoice.total) -
      Number(invoice.amountPaid) +
      invoice.bundledReceipts.reduce((s, d) => s + Number(d.total) - Number(d.amountPaid), 0);
    if (!['issued', 'overdue'].includes(invoice.status) || pending <= 0) {
      throw new BadRequestException({
        code: 'invoice_not_payable',
        message: 'Esta factura no tiene nada pendiente de pago',
      });
    }
    const options = await this.options(tenantId);
    const available =
      input.method === 'bank_transfer'
        ? options.bankTransfer
        : input.method === 'cash'
          ? options.payAtFacility
          : options.sepaDebit;
    if (!available) {
      throw new BadRequestException({
        code: 'offline_method_not_available',
        message: 'Esta forma de pago no está disponible',
      });
    }

    // Reserva aún retenida: se guarda la elección y, con transferencia o pago en
    // el local, se amplía el plazo una sola vez (la domiciliación no caduca
    // mientras haya un mandato firmado: ver `expireUnpaidBookings`).
    const contract = invoice.contract;
    let holdUntil: Date | null = null;
    if (contract?.firstPaymentDeadline && ['draft', 'active'].includes(contract.status)) {
      holdUntil = contract.firstPaymentDeadline;
      const extend =
        EXTENDS_HOLD.includes(input.method) &&
        !EXTENDS_HOLD.includes(contract.offlinePaymentMethod as OfflinePaymentMethodValue);
      const newDeadline = extend
        ? new Date(contract.firstPaymentDeadline.getTime() + OFFLINE_PAYMENT_EXTRA_HOURS * HOUR_MS)
        : null;
      const { count } = await this.prisma.withTenant(
        (tx) =>
          tx.contract.updateMany({
            // Condicionado a lo leído: dos peticiones a la vez no amplían dos veces.
            where: { id: contract.id, offlinePaymentMethod: contract.offlinePaymentMethod },
            data: {
              offlinePaymentMethod: input.method,
              offlinePaymentChosenAt: new Date(),
              ...(newDeadline ? { firstPaymentDeadline: newDeadline } : {}),
            },
          }),
        tenantId,
      );
      if (count > 0 && newDeadline) holdUntil = newDeadline;
    }

    const customer = invoice.customer;
    const locale = emailLocale(customer?.locale);
    const numbers = [invoice.invoiceNumber, ...invoice.bundledReceipts.map((d) => d.invoiceNumber)]
      .filter(Boolean)
      .join(' y ');
    let emailSentTo: string | null = null;
    let mandateSigningUrl: string | null = null;

    if (input.method === 'bank_transfer') {
      if (!customer?.email) {
        throw new BadRequestException({
          code: 'customer_without_email',
          message: 'No tenemos tu correo para enviarte los datos de la transferencia',
        });
      }
      await this.sendTransferEmail({
        tenantId,
        invoiceId: invoice.id,
        contractId: contract?.id ?? null,
        customerId,
        email: customer.email,
        firstName: customer.firstName,
        amount: pending,
        concept: numbers,
        holdUntil,
        locale,
      });
      emailSentTo = customer.email;
    } else if (input.method === 'sepa_debit') {
      mandateSigningUrl = await this.ensureMandate(tenantId, customerId, input);
    }

    const name =
      customer?.companyName?.trim() ||
      [customer?.firstName, customer?.lastName].filter(Boolean).join(' ').trim() ||
      'Un inquilino';
    const holdText = holdUntil
      ? ` La reserva se guarda hasta el ${formatDateLong(holdUntil)} a las ${hourOf(holdUntil, 'es')}.`
      : '';
    const next =
      input.method === 'sepa_debit'
        ? ' Cuando firme el mandato, inclúyela en la próxima remesa SEPA.'
        : ' Cuando recibas el dinero, márcala como pagada indicando cómo se ha cobrado.';
    await this.notifications
      .create(tenantId, {
        type: 'invoice.offline_payment_chosen',
        title: `${name} ${STAFF_TITLE[input.method]} la factura ${numbers}`,
        body: `${formatEur(pending)} pendientes.${holdText}${next}`,
        link: `/invoices/${invoice.id}`,
        invoiceId: invoice.id,
        contractId: contract?.id ?? null,
      })
      .catch(() => undefined);

    return {
      method: input.method,
      holdUntil: holdUntil ? holdUntil.toISOString() : null,
      emailSentTo,
      mandateSigningUrl,
    };
  }

  /**
   * Mandato SEPA del inquilino: si ya tiene uno firmado de esa cuenta, sirve;
   * si no, se da de alta y se devuelve el enlace para firmarlo ahora.
   */
  private async ensureMandate(
    tenantId: string,
    customerId: string,
    input: PortalOfflinePaymentInput,
  ): Promise<string | null> {
    const iban = input.iban!;
    const current = await this.prisma.withTenant(
      (tx) =>
        tx.sepaMandate.findFirst({
          where: { tenantId, customerId, status: 'active' },
          select: { ibanLast4: true, signatureStatus: true },
        }),
      tenantId,
    );
    if (
      current &&
      current.ibanLast4 === iban.slice(-4) &&
      ['signed', 'external'].includes(current.signatureStatus)
    ) {
      return null;
    }
    const mandate = await this.sepa.createMandate(tenantId, {
      customerId,
      iban,
      bic: input.bic ?? '',
      signedOutside: false,
    });
    return mandate.signingUrl ?? null;
  }

  private async sendTransferEmail(args: {
    tenantId: string;
    invoiceId: string;
    contractId: string | null;
    customerId: string;
    email: string;
    firstName: string | null;
    amount: number;
    concept: string;
    holdUntil: Date | null;
    locale: EmailLocale;
  }): Promise<void> {
    const tenant = await this.prisma.withTenant(
      (tx) =>
        tx.tenant.findUnique({
          where: { id: args.tenantId },
          select: { name: true, billingLegalName: true, transferIban: true },
        }),
      args.tenantId,
    );
    if (!tenant?.transferIban) return;
    const en = args.locale === 'en';
    const iban = tenant.transferIban.replace(/(.{4})/g, '$1 ').trim();
    const holder = tenant.billingLegalName?.trim() || tenant.name;
    const amount = formatEur(args.amount, args.locale);
    const first = args.firstName?.trim();
    const hi = en ? `Hello${first ? ` ${first}` : ''},` : `Hola${first ? ` ${first}` : ''},`;
    const when = args.holdUntil
      ? `${formatDateLong(args.holdUntil, 'Europe/Madrid', args.locale)} ${en ? 'at' : 'a las'} ${hourOf(args.holdUntil, args.locale)}`
      : null;
    const lines = en
      ? [
          ['Account holder', holder],
          ['IBAN', iban],
          ['Amount', amount],
          ['Reference', args.concept],
        ]
      : [
          ['Titular', holder],
          ['IBAN', iban],
          ['Importe', amount],
          ['Concepto', args.concept],
        ];
    const intro = en
      ? 'To pay by bank transfer, please use these details:'
      : 'Para pagar por transferencia, usa estos datos:';
    const keep = when
      ? en
        ? `We keep your storage unit reserved until ${when}. Your access will be activated as soon as we receive the payment.`
        : `Te guardamos el trastero hasta el ${when}. En cuanto recibamos el pago, activaremos tu acceso.`
      : en
        ? 'We will confirm as soon as we receive the payment.'
        : 'Te lo confirmaremos en cuanto recibamos el pago.';
    const conceptNote = en
      ? 'Please include the reference so we can match your payment.'
      : 'Pon el concepto tal cual para que podamos identificar tu pago.';
    const sign = en ? `Kind regards,\n${tenant.name}` : `Un saludo,\nEl equipo de ${tenant.name}`;
    const subject = en
      ? `Bank transfer details — ${args.concept}`
      : `Datos para pagar por transferencia — ${args.concept}`;
    const bodyText = [
      hi,
      '',
      intro,
      '',
      ...lines.map(([k, v]) => `${k}: ${v}`),
      '',
      conceptNote,
      keep,
      '',
      sign,
    ].join('\n');
    const esc = (v: string) =>
      v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const bodyHtml =
      `<p>${esc(hi)}</p><p>${esc(intro)}</p>` +
      `<table style="border-collapse:collapse">${lines
        .map(
          ([k, v]) =>
            `<tr><td style="padding:4px 12px 4px 0;color:#666">${esc(k!)}</td><td style="padding:4px 0"><strong>${esc(v!)}</strong></td></tr>`,
        )
        .join('')}</table>` +
      `<p>${esc(conceptNote)}</p><p>${esc(keep)}</p>`;
    await this.communications.enqueue({
      tenantId: args.tenantId,
      channel: 'email',
      recipient: args.email,
      subject,
      bodyText,
      bodyHtml,
      customerId: args.customerId,
      invoiceId: args.invoiceId,
      contractId: args.contractId,
      source: 'offline_payment.transfer',
    });
  }
}

function hourOf(d: Date, locale: EmailLocale): string {
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Madrid',
  }).format(d);
}
