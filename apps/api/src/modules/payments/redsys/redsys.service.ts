import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { toCents } from '../../../common/money';
import { assertNotInSepaRemittance } from '../../../common/sepa-remittance-guard';
import { InvoicesService } from '../../billing/invoices.service';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { PrismaService } from '../../database/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { PaymentMethodsService } from '../payment-methods.service';

import { savedCardFromNotification } from './redsys-charge.service';
import { RedsysSettingsService } from './redsys-settings.service';
import {
  decodeMerchantParameters,
  encodeMerchantParameters,
  generateRedsysOrder,
  REDSYS_ENDPOINTS,
  REDSYS_SIGNATURE_VERSION,
  signRequest,
  verifyNotification,
} from './redsys-signature';

import type { Env } from '../../../config/env.schema';
import type { RedsysPayMethod, RedsysRedirectDto } from '@storageos/shared';

@Injectable()
export class RedsysService {
  private readonly logger = new Logger(RedsysService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly prisma: PrismaService,
    private readonly settings: RedsysSettingsService,
    private readonly invoices: InvoicesService,
    private readonly config: ConfigService<Env, true>,
    private readonly notifications: NotificationsService,
    private readonly paymentMethods: PaymentMethodsService,
  ) {}

  /**
   * Construye el formulario firmado para redirigir el pago de una factura a
   * Redsys. Si se pasa `expectedCustomerId` (portal del inquilino), valida que
   * la factura sea suya.
   */
  async createRedirect(
    tenantId: string,
    invoiceId: string,
    opts?: { expectedCustomerId?: string; payMethod?: RedsysPayMethod; saveCard?: boolean },
  ): Promise<RedsysRedirectDto> {
    const expectedCustomerId = opts?.expectedCustomerId;
    const payMethod = opts?.payMethod;
    const cfg = await this.settings.getResolved(tenantId);
    if (!cfg || !cfg.enabled) {
      throw new BadRequestException({
        code: 'redsys_not_enabled',
        message: 'La pasarela Redsys no está activa',
      });
    }
    if (payMethod === 'bizum' && !cfg.bizumEnabled) {
      throw new BadRequestException({
        code: 'bizum_not_enabled',
        message: 'El pago con Bizum no está activo para este negocio',
      });
    }
    const invoice = await this.admin.invoice.findFirst({
      where: { id: invoiceId, tenantId, deletedAt: null },
    });
    if (!invoice || (expectedCustomerId && invoice.customerId !== expectedCustomerId)) {
      throw new NotFoundException({ code: 'invoice_not_found', message: 'Factura no encontrada' });
    }
    if (invoice.status !== 'issued' && invoice.status !== 'overdue') {
      throw new BadRequestException({
        code: 'invoice_not_payable',
        message: 'La factura no está en estado pagable',
      });
    }
    // No iniciar Redsys si ya hay un cobro en vuelo (p. ej. un adeudo SEPA
    // `processing`) sobre la misma factura → evita el doble cobro.
    const inFlight = await this.admin.payment.count({
      where: { invoiceId, tenantId, status: { in: ['processing', 'pending'] } },
    });
    if (inFlight > 0) {
      throw new ConflictException({
        code: 'payment_in_progress',
        message: 'Ya hay un pago en curso para esta factura. Espera a que se confirme.',
      });
    }
    // En una remesa SEPA sin confirmar: el banco la cobrará.
    await assertNotInSepaRemittance(this.admin, invoiceId);
    // Céntimos enteros ANTES de restar: restar decimales y redondear después
    // arrastra el drift de coma flotante al importe enviado a Redsys.
    // Con su justificante de fianza (reserva online): un solo pago por el total.
    const bundled = await this.admin.invoice.findMany({
      where: {
        tenantId,
        bundledWithInvoiceId: invoiceId,
        kind: 'deposit_receipt',
        status: { in: ['issued', 'overdue'] },
        deletedAt: null,
      },
      select: { total: true, amountPaid: true },
    });
    const amountCents =
      toCents(invoice.total) -
      toCents(invoice.amountPaid) +
      bundled.reduce((sum, r) => sum + Math.max(0, toCents(r.total) - toCents(r.amountPaid)), 0);
    if (amountCents <= 0) {
      throw new BadRequestException({
        code: 'nothing_to_pay',
        message: 'No hay importe pendiente',
      });
    }

    // Pago por referencia: guardar la tarjeta (solo con tarjeta, si el banco lo
    // tiene activo y la factura es de un inquilino).
    const saveCard =
      !!opts?.saveCard && cfg.cardOnFileEnabled && payMethod !== 'bizum' && !!invoice.customerId;

    // Una orden Redsys `pending` NO crea fila en `payments` hasta que el
    // webhook la confirma (a diferencia de Stripe/GoCardless, que reservan un
    // `payment` `processing` antes de cobrar) → sin este candado, el check de
    // arriba no ve nada y dos requests casi simultáneos (doble clic, dos
    // pestañas) generarían dos órdenes `pending` distintas para la misma
    // factura; si el cliente llegara a pagar ambas, la segunda confirmación
    // se perdería silenciosamente (ver `handleNotification`). El advisory
    // lock serializa los intentos concurrentes; dentro de él, si YA hay una
    // orden `pending` para esta factura se REUTILIZA (mismo `order`, misma
    // firma recalculada) en vez de crear otra — el índice único parcial
    // `redsys_orders_one_pending_per_invoice` es el backstop a nivel BD por
    // si algún otro camino se saltara este lock.
    const orderRow = await this.prisma.withTenant(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}::text), hashtext(${invoiceId}::text))`;
      const existing = await tx.redsysOrder.findFirst({
        where: { tenantId, invoiceId, status: 'pending' },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) {
        if (existing.saveCard === saveCard) return existing;
        return tx.redsysOrder.update({ where: { order: existing.order }, data: { saveCard } });
      }
      return tx.redsysOrder.create({
        data: {
          order: generateRedsysOrder(),
          tenantId,
          invoiceId,
          amountCents,
          status: 'pending',
          saveCard,
        },
      });
    }, tenantId);
    const order = orderRow.order;

    const webBase = this.config.get('WEB_BASE_URL', { infer: true });
    const apiBase = this.config.get('API_BASE_URL', { infer: true });
    const merchantParams: Record<string, string> = {
      // El importe SIEMPRE es el de `orderRow` (no el `amountCents` recién
      // calculado arriba): si se reutiliza una orden ya existente, el
      // formulario debe coincidir con lo que quedó grabado para ese `order`
      // — es lo que `handleNotification` usará para cobrar al confirmar.
      DS_MERCHANT_AMOUNT: String(orderRow.amountCents),
      DS_MERCHANT_ORDER: order,
      DS_MERCHANT_MERCHANTCODE: cfg.merchantCode,
      DS_MERCHANT_CURRENCY: '978',
      DS_MERCHANT_TRANSACTIONTYPE: '0',
      DS_MERCHANT_TERMINAL: cfg.terminal,
      DS_MERCHANT_MERCHANTURL: `${apiBase}/webhooks/redsys`,
      DS_MERCHANT_URLOK: `${webBase}/pay/redsys/ok`,
      DS_MERCHANT_URLKO: `${webBase}/pay/redsys/ko`,
      DS_MERCHANT_PRODUCTDESCRIPTION: `Factura ${invoice.invoiceNumber}`,
      // 'z' = Bizum, 'C' = tarjeta. Sin el campo, el TPV ofrece los métodos que
      // tenga configurados el comercio (retrocompatible con el flujo anterior).
      ...(payMethod ? { DS_MERCHANT_PAYMETHODS: payMethod === 'bizum' ? 'z' : 'C' } : {}),
      // Pago por referencia: Redsys guarda la tarjeta (credencial para cobros
      // recurrentes iniciados por el comercio) y la devuelve en la notificación.
      ...(orderRow.saveCard
        ? {
            DS_MERCHANT_PAYMETHODS: 'C',
            DS_MERCHANT_IDENTIFIER: 'REQUIRED',
            DS_MERCHANT_COF_INI: 'S',
            DS_MERCHANT_COF_TYPE: 'R',
          }
        : {}),
    };
    const merchantParameters = encodeMerchantParameters(merchantParams);
    const signature = signRequest(merchantParameters, order, cfg.secretKey);

    return {
      url: REDSYS_ENDPOINTS[cfg.environment],
      signatureVersion: REDSYS_SIGNATURE_VERSION,
      merchantParameters,
      signature,
    };
  }

  /** ¿Tiene el tenant la pasarela Redsys activa? (para gatear el botón del portal). */
  async isEnabled(tenantId: string): Promise<boolean> {
    const cfg = await this.settings.getResolved(tenantId);
    return !!cfg?.enabled;
  }

  /** Estado de Redsys para gatear los botones del portal (tarjeta y Bizum). */
  async availability(tenantId: string): Promise<{
    enabled: boolean;
    bizumEnabled: boolean;
    cardEnabled: boolean;
    cardOnFileEnabled: boolean;
  }> {
    const [cfg, tenant, stripe] = await Promise.all([
      this.settings.getResolved(tenantId),
      this.admin.tenant.findUnique({ where: { id: tenantId }, select: { cardProvider: true } }),
      this.admin.tenantStripeAccount.findUnique({
        where: { tenantId },
        select: { chargesEnabled: true },
      }),
    ]);
    const enabled = !!cfg?.enabled;
    // Con la tarjeta por Stripe (Connect), Redsys queda solo para Bizum.
    const cardViaStripe = tenant?.cardProvider === 'stripe' && !!stripe?.chargesEnabled;
    return {
      enabled,
      bizumEnabled: !!(enabled && cfg?.bizumEnabled),
      cardEnabled: enabled && !cardViaStripe,
      // Se puede guardar la tarjeta para cobrar solas las próximas cuotas.
      cardOnFileEnabled: enabled && !cardViaStripe && !!cfg?.cardOnFileEnabled,
    };
  }

  /** Procesa la notificación servidor-a-servidor de Redsys. */
  async handleNotification(body: {
    Ds_MerchantParameters?: string | undefined;
    Ds_Signature?: string | undefined;
  }): Promise<void> {
    const mp = body.Ds_MerchantParameters;
    const sig = body.Ds_Signature;
    if (!mp || !sig) {
      this.logger.warn('[redsys] notificación sin parámetros/firma');
      return;
    }
    let order = '';
    try {
      const decoded = decodeMerchantParameters(mp);
      order = decoded.Ds_Order ?? decoded.DS_ORDER ?? '';
    } catch {
      this.logger.warn('[redsys] notificación con parámetros ilegibles');
      return;
    }
    const orderRow = await this.admin.redsysOrder.findUnique({ where: { order } });
    if (!orderRow) {
      this.logger.warn(`[redsys] order ${order} desconocida`);
      return;
    }
    if (orderRow.status === 'paid') return; // idempotente

    const cfg = await this.settings.getResolved(orderRow.tenantId);
    if (!cfg) {
      this.logger.error(`[redsys] tenant ${orderRow.tenantId} sin config; no se verifica`);
      return;
    }
    const { valid, params } = verifyNotification(mp, sig, cfg.secretKey);
    if (!valid) {
      this.logger.error(`[redsys] firma inválida en order ${order}`);
      return;
    }

    const dsResponse = params.Ds_Response ?? params.DS_RESPONSE ?? '';
    const code = Number(dsResponse);
    const approved = Number.isFinite(code) && code >= 0 && code <= 99;

    // Transición ATÓMICA: `updateMany` condicionado a `status: 'pending'` → solo
    // la PRIMERA notificación cambia el estado (count 1) y procede al cobro; una
    // notificación concurrente o reentregada por Redsys ve count 0 y NO vuelve a
    // llamar `markPaidManually` (evita un Payment duplicado). Sustituye al
    // guard `status === 'paid'` leído fuera de transacción (no atómico).
    const { count } = await this.prisma.withTenant(
      (tx) =>
        tx.redsysOrder.updateMany({
          where: { order, status: 'pending' },
          data: {
            status: approved ? 'paid' : 'failed',
            dsResponse,
            ...(approved ? { paidAt: new Date() } : {}),
          },
        }),
      orderRow.tenantId,
    );
    if (count === 0) {
      this.logger.log(`[redsys] order ${order} ya procesada (notificación duplicada); ignorada`);
      return;
    }

    if (approved && orderRow.saveCard) {
      await this.saveCardFromNotification(orderRow, params);
    }

    if (approved) {
      try {
        // El cobro se reparte: primero la factura, después su justificante de
        // fianza (reserva online, un solo pago por el total).
        for (const part of await this.splitOrder(orderRow)) {
          await this.invoices.markPaidManually({
            tenantId: orderRow.tenantId,
            userId: null,
            invoiceId: part.invoiceId,
            input: {
              amount: part.cents / 100,
              methodType: 'card',
              notes: `Redsys ${order}`,
              // Confirmación de un pago real por Redsys: salta el guard de adeudo en vuelo.
              overridePaymentInFlight: true,
              allowInSepaRemittance: true,
            },
            meta: {},
          });
        }
      } catch (err) {
        // La factura podría estar ya pagada por otra vía (transferencia, otra
        // orden Redsys legítima, etc.): no es fatal para el webhook (Redsys
        // espera un ACK), pero el dinero de este cobro real NO puede quedar
        // solo en un log que nadie revisa — se deja constancia accionable
        // para el staff del tenant (reconciliar manualmente / reembolsar
        // desde el panel de Redsys si procede).
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn(`[redsys] order ${order} aprobada pero markPaid falló: ${reason}`);
        await this.notifications
          .create(orderRow.tenantId, {
            type: 'redsys.overpayment_needs_review',
            title: 'Cobro de Redsys sin aplicar — requiere revisión',
            body: `Se confirmó un pago de Redsys (${(orderRow.amountCents / 100).toFixed(2)} €, orden ${order}) para la factura, pero no se pudo aplicar automáticamente: ${reason}. Revisa si hay que reembolsarlo o aplicarlo a otra factura.`,
            link: `/invoices/${orderRow.invoiceId}`,
          })
          .catch((notifyErr: unknown) => {
            this.logger.error(
              `[redsys] no se pudo registrar la notificación de revisión para order ${order}: ${
                notifyErr instanceof Error ? notifyErr.message : String(notifyErr)
              }`,
            );
          });
      }
    }
  }

  /**
   * Pago por referencia: guarda la tarjeta que devolvió Redsys como método de
   * pago por defecto del inquilino (las cuotas siguientes se cobran solas).
   * Nunca rompe la confirmación del pago.
   */
  private async saveCardFromNotification(
    orderRow: { order: string; tenantId: string; invoiceId: string },
    params: Record<string, string>,
  ): Promise<void> {
    const card = savedCardFromNotification(params);
    if (!card) {
      this.logger.warn(`[redsys] order ${orderRow.order} sin referencia de tarjeta`);
      return;
    }
    try {
      const invoice = await this.admin.invoice.findUnique({
        where: { id: orderRow.invoiceId },
        select: { customerId: true },
      });
      if (!invoice?.customerId) return;
      // La tarjeta nueva sustituye a la que hubiera guardada en Redsys.
      await this.admin.paymentMethod.updateMany({
        where: {
          tenantId: orderRow.tenantId,
          customerId: invoice.customerId,
          gateway: 'redsys',
          deletedAt: null,
        },
        data: { deletedAt: new Date(), isDefault: false },
      });
      await this.paymentMethods.registerResolved({
        tenantId: orderRow.tenantId,
        userId: null,
        customerId: invoice.customerId,
        gateway: 'redsys',
        type: 'card',
        token: card.identifier,
        last4: card.last4,
        brand: card.brand,
        expMonth: card.expMonth,
        expYear: card.expYear,
        networkTxnId: card.cofTxnId,
        isDefault: true,
        meta: {},
      });
    } catch (err) {
      this.logger.warn(
        `[redsys] no se pudo guardar la tarjeta de la order ${orderRow.order}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Reparte el importe de una orden entre la factura y sus justificantes de
   * fianza pendientes. Lo que sobre se aplica a la factura (y el cobro manual
   * lo rechazará como sobrecobro → aviso de revisión).
   */
  private async splitOrder(orderRow: {
    tenantId: string;
    invoiceId: string;
    amountCents: number;
  }): Promise<{ invoiceId: string; cents: number }[]> {
    const docs = await this.admin.invoice.findMany({
      where: {
        tenantId: orderRow.tenantId,
        OR: [
          { id: orderRow.invoiceId },
          { bundledWithInvoiceId: orderRow.invoiceId, kind: 'deposit_receipt' },
        ],
        status: { in: ['issued', 'overdue'] },
        deletedAt: null,
      },
      select: { id: true, total: true, amountPaid: true },
    });
    docs.sort((a, b) => Number(b.id === orderRow.invoiceId) - Number(a.id === orderRow.invoiceId));
    let remaining = orderRow.amountCents;
    const parts: { invoiceId: string; cents: number }[] = [];
    for (const d of docs) {
      const pendingCents = Math.max(0, toCents(d.total) - toCents(d.amountPaid));
      const cents = Math.min(remaining, pendingCents);
      if (cents > 0) parts.push({ invoiceId: d.id, cents });
      remaining -= cents;
    }
    if (remaining > 0 || parts.length === 0) {
      parts.push({
        invoiceId: orderRow.invoiceId,
        cents: remaining > 0 ? remaining : orderRow.amountCents,
      });
    }
    return parts;
  }
}
