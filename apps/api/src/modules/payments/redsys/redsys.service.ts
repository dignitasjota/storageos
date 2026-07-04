import { randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { toCents } from '../../../common/money';
import { InvoicesService } from '../../billing/invoices.service';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { PrismaService } from '../../database/prisma.service';

import { RedsysSettingsService } from './redsys-settings.service';
import {
  decodeMerchantParameters,
  encodeMerchantParameters,
  REDSYS_ENDPOINTS,
  REDSYS_SIGNATURE_VERSION,
  signRequest,
  verifyNotification,
} from './redsys-signature';

import type { Env } from '../../../config/env.schema';
import type { RedsysRedirectDto } from '@storageos/shared';

/** Genera un `Ds_Merchant_Order` de 12 chars (primeros 4 numéricos). */
function generateOrder(): string {
  const numeric = String(Math.floor(1000 + Math.random() * 9000));
  const rest = randomBytes(8).toString('hex').slice(0, 8);
  return `${numeric}${rest}`;
}

@Injectable()
export class RedsysService {
  private readonly logger = new Logger(RedsysService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly prisma: PrismaService,
    private readonly settings: RedsysSettingsService,
    private readonly invoices: InvoicesService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Construye el formulario firmado para redirigir el pago de una factura a
   * Redsys. Si se pasa `expectedCustomerId` (portal del inquilino), valida que
   * la factura sea suya.
   */
  async createRedirect(
    tenantId: string,
    invoiceId: string,
    expectedCustomerId?: string,
  ): Promise<RedsysRedirectDto> {
    const cfg = await this.settings.getResolved(tenantId);
    if (!cfg || !cfg.enabled) {
      throw new BadRequestException({
        code: 'redsys_not_enabled',
        message: 'La pasarela Redsys no está activa',
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
    // Céntimos enteros ANTES de restar: restar decimales y redondear después
    // arrastra el drift de coma flotante al importe enviado a Redsys.
    const amountCents = toCents(invoice.total) - toCents(invoice.amountPaid);
    if (amountCents <= 0) {
      throw new BadRequestException({
        code: 'nothing_to_pay',
        message: 'No hay importe pendiente',
      });
    }

    const order = generateOrder();
    await this.prisma.withTenant(
      (tx) =>
        tx.redsysOrder.create({
          data: { order, tenantId, invoiceId, amountCents, status: 'pending' },
        }),
      tenantId,
    );

    const webBase = this.config.get('WEB_BASE_URL', { infer: true });
    const apiBase = this.config.get('API_BASE_URL', { infer: true });
    const merchantParams: Record<string, string> = {
      DS_MERCHANT_AMOUNT: String(amountCents),
      DS_MERCHANT_ORDER: order,
      DS_MERCHANT_MERCHANTCODE: cfg.merchantCode,
      DS_MERCHANT_CURRENCY: '978',
      DS_MERCHANT_TRANSACTIONTYPE: '0',
      DS_MERCHANT_TERMINAL: cfg.terminal,
      DS_MERCHANT_MERCHANTURL: `${apiBase}/webhooks/redsys`,
      DS_MERCHANT_URLOK: `${webBase}/pay/redsys/ok`,
      DS_MERCHANT_URLKO: `${webBase}/pay/redsys/ko`,
      DS_MERCHANT_PRODUCTDESCRIPTION: `Factura ${invoice.invoiceNumber}`,
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

    await this.prisma.withTenant(
      (tx) =>
        tx.redsysOrder.update({
          where: { order },
          data: {
            status: approved ? 'paid' : 'failed',
            dsResponse,
            ...(approved ? { paidAt: new Date() } : {}),
          },
        }),
      orderRow.tenantId,
    );

    if (approved) {
      try {
        await this.invoices.markPaidManually({
          tenantId: orderRow.tenantId,
          userId: null,
          invoiceId: orderRow.invoiceId,
          input: {
            amount: orderRow.amountCents / 100,
            methodType: 'card',
            notes: `Redsys ${order}`,
          },
          meta: {},
        });
      } catch (err) {
        // La factura podría estar ya pagada (doble notificación): no es fatal.
        this.logger.warn(
          `[redsys] order ${order} aprobada pero markPaid falló: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}
