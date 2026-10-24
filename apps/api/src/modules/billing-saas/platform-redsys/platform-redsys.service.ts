import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CryptoService } from '../../../common/crypto/crypto.service';
import { toCents } from '../../../common/money';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import {
  decodeMerchantParameters,
  encodeMerchantParameters,
  generateRedsysOrder,
  REDSYS_ENDPOINTS,
  REDSYS_SIGNATURE_VERSION,
  signRequest,
  verifyNotification,
} from '../../payments/redsys/redsys-signature';
import { BillingSaasService } from '../billing-saas.service';
import { amountToCharge, platformPricing } from '../platform-pricing';
import { SaasAddonsService } from '../saas-addons.service';

import type { Env } from '../../../config/env.schema';
import type {
  RedsysPayMethod,
  RedsysRedirectDto,
  RedsysSettingsDto,
  TenantRedsysPaymentOptionsDto,
  UpdateRedsysSettingsInput,
} from '@storageos/shared';

/** AAD fijo para la clave del TPV de la plataforma (sin scope de tenant). */
const SECRET_AAD = 'platform-redsys-settings';

interface ResolvedSettings {
  merchantCode: string;
  terminal: string;
  secretKey: string;
  environment: 'test' | 'live';
  enabled: boolean;
  bizumEnabled: boolean;
  cardOnFileEnabled: boolean;
}

/**
 * TPV virtual (Redsys) de la plataforma: el tenant paga su suscripción con
 * tarjeta o Bizum desde Ajustes → Suscripción. Mismo protocolo que el Redsys
 * de los tenants (`payments/redsys`), con su propia configuración y su propio
 * aviso (`/webhooks/redsys/platform`). El pago confirmado se registra como un
 * pago más de la suscripción (`recordManualPayment`): extiende un mes el
 * periodo, emite la factura y saca al tenant del impago.
 *
 * Solo para tenants que pagan a mano (sin Stripe ni domiciliación SEPA): en
 * esos modos el cobro ya va solo y se cobraría dos veces.
 */
@Injectable()
export class PlatformRedsysService {
  private readonly logger = new Logger(PlatformRedsysService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService<Env, true>,
    private readonly billing: BillingSaasService,
    private readonly addons: SaasAddonsService,
  ) {}

  // ------------------------------ ajustes ------------------------------

  async getSettings(): Promise<RedsysSettingsDto> {
    const row = await this.admin.platformRedsysSettings.findFirst();
    return {
      merchantCode: row?.merchantCode ?? '',
      terminal: row?.terminal ?? '1',
      environment: (row?.environment as 'test' | 'live') ?? 'test',
      enabled: row?.enabled ?? false,
      bizumEnabled: row?.bizumEnabled ?? false,
      hasSecretKey: !!row?.secretKeyEncrypted,
      cardOnFileEnabled: row?.cardOnFileEnabled ?? false,
    };
  }

  async updateSettings(input: UpdateRedsysSettingsInput): Promise<RedsysSettingsDto> {
    const existing = await this.admin.platformRedsysSettings.findFirst();
    const secretKeyEncrypted = input.secretKey
      ? this.crypto.encryptString(input.secretKey, SECRET_AAD)
      : (existing?.secretKeyEncrypted ?? null);
    if (input.enabled && !secretKeyEncrypted) {
      throw new BadRequestException({
        code: 'redsys_secret_required',
        message: 'Necesitas la clave secreta del TPV para activarlo',
      });
    }
    const data = {
      merchantCode: input.merchantCode,
      terminal: input.terminal,
      secretKeyEncrypted,
      environment: input.environment,
      enabled: input.enabled,
      bizumEnabled: input.enabled && input.bizumEnabled,
      cardOnFileEnabled: input.enabled && input.cardOnFileEnabled,
    };
    if (existing) {
      await this.admin.platformRedsysSettings.update({ where: { id: existing.id }, data });
    } else {
      await this.admin.platformRedsysSettings.create({ data });
    }
    return this.getSettings();
  }

  async resolved(): Promise<ResolvedSettings | null> {
    const row = await this.admin.platformRedsysSettings.findFirst();
    if (!row?.secretKeyEncrypted || !row.merchantCode) return null;
    return {
      merchantCode: row.merchantCode,
      terminal: row.terminal,
      secretKey: this.crypto.decryptString(row.secretKeyEncrypted, SECRET_AAD),
      environment: row.environment as 'test' | 'live',
      enabled: row.enabled,
      bizumEnabled: row.bizumEnabled,
      cardOnFileEnabled: row.cardOnFileEnabled,
    };
  }

  // --------------------------- pago del tenant ---------------------------

  /** Qué puede pagar el tenant con el TPV de la plataforma y cuánto. */
  async paymentOptions(tenantId: string): Promise<TenantRedsysPaymentOptionsDto> {
    const [cfg, sub, tenant] = await Promise.all([
      this.resolved(),
      this.admin.tenantSubscription.findUnique({
        where: { tenantId },
        include: { plan: { select: { name: true, priceMonthly: true } } },
      }),
      this.admin.tenant.findUnique({ where: { id: tenantId }, select: { billingExempt: true } }),
    ]);
    const base: TenantRedsysPaymentOptionsDto = {
      available: false,
      cardEnabled: false,
      bizumEnabled: false,
      amount: 0,
      currency: 'EUR',
      currentPeriodEnd: sub?.currentPeriodEnd.toISOString() ?? null,
      pastDue: sub?.status === 'past_due',
      planName: sub?.plan.name ?? null,
      reason: null,
    };
    if (!cfg?.enabled) return { ...base, reason: 'not_configured' };
    if (!sub) return { ...base, reason: 'no_subscription' };
    if (tenant?.billingExempt) return { ...base, reason: 'exempt' };
    if (sub.billingMode !== 'manual') return { ...base, reason: 'not_manual' };
    const amount = await this.amountDue(tenantId);
    if (amount <= 0) return { ...base, reason: 'free_plan' };
    return {
      ...base,
      available: true,
      cardEnabled: true,
      bizumEnabled: cfg.bizumEnabled,
      amount,
      reason: null,
    };
  }

  /**
   * Formulario firmado para pagar un mes de la suscripción en el TPV de la
   * plataforma. Una orden pendiente por tenant: un doble clic reutiliza la
   * misma si el importe no ha cambiado.
   */
  async createRedirect(
    tenantId: string,
    opts: { payMethod?: RedsysPayMethod | undefined },
  ): Promise<RedsysRedirectDto> {
    const cfg = await this.resolved();
    const options = await this.paymentOptions(tenantId);
    if (!cfg || !options.available) {
      throw new BadRequestException({
        code: options.reason === 'not_configured' ? 'redsys_not_enabled' : 'redsys_not_available',
        message:
          options.reason === 'not_manual'
            ? 'Tu suscripción ya se cobra sola (tarjeta o domiciliación).'
            : 'El pago con tarjeta no está disponible para tu suscripción.',
      });
    }
    if (opts.payMethod === 'bizum' && !cfg.bizumEnabled) {
      throw new BadRequestException({
        code: 'bizum_not_enabled',
        message: 'El pago con Bizum no está activo',
      });
    }
    const amountCents = toCents(options.amount);
    const payMethod = opts.payMethod ?? null;
    const orderRow = await this.admin.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`platform-redsys:${tenantId}`}))`;
      const existing = await tx.platformRedsysOrder.findFirst({
        where: { tenantId, status: 'pending' },
        orderBy: { createdAt: 'desc' },
      });
      if (existing && existing.amountCents === amountCents && existing.payMethod === payMethod) {
        return existing;
      }
      if (existing) {
        await tx.platformRedsysOrder.update({
          where: { order: existing.order },
          data: { status: 'replaced' },
        });
      }
      return tx.platformRedsysOrder.create({
        data: { order: generateRedsysOrder(), tenantId, amountCents, payMethod, status: 'pending' },
      });
    });

    const webBase = this.config.get('WEB_BASE_URL', { infer: true });
    const apiBase = this.config.get('API_BASE_URL', { infer: true });
    const params: Record<string, string> = {
      DS_MERCHANT_AMOUNT: String(orderRow.amountCents),
      DS_MERCHANT_ORDER: orderRow.order,
      DS_MERCHANT_MERCHANTCODE: cfg.merchantCode,
      DS_MERCHANT_CURRENCY: '978',
      DS_MERCHANT_TRANSACTIONTYPE: '0',
      DS_MERCHANT_TERMINAL: cfg.terminal,
      DS_MERCHANT_MERCHANTURL: `${apiBase}/webhooks/redsys/platform`,
      DS_MERCHANT_URLOK: `${webBase}/settings/saas-billing?redsys=ok`,
      DS_MERCHANT_URLKO: `${webBase}/settings/saas-billing?redsys=ko`,
      DS_MERCHANT_PRODUCTDESCRIPTION: `Suscripción TrasterOS · ${options.planName ?? ''}`
        .trim()
        .slice(0, 125),
      // 'z' = Bizum, 'C' = tarjeta; sin el campo el TPV ofrece lo que tenga activo.
      ...(payMethod ? { DS_MERCHANT_PAYMETHODS: payMethod === 'bizum' ? 'z' : 'C' } : {}),
    };
    const merchantParameters = encodeMerchantParameters(params);
    return {
      url: REDSYS_ENDPOINTS[cfg.environment],
      signatureVersion: REDSYS_SIGNATURE_VERSION,
      merchantParameters,
      signature: signRequest(merchantParameters, orderRow.order, cfg.secretKey),
    };
  }

  /** Aviso servidor a servidor de Redsys para un pago de suscripción. */
  async handleNotification(body: {
    Ds_MerchantParameters?: string | undefined;
    Ds_Signature?: string | undefined;
  }): Promise<void> {
    const mp = body.Ds_MerchantParameters;
    const sig = body.Ds_Signature;
    if (!mp || !sig) {
      this.logger.warn('[redsys-platform] aviso sin parámetros o firma');
      return;
    }
    let order = '';
    try {
      const decoded = decodeMerchantParameters(mp);
      order = decoded.Ds_Order ?? decoded.DS_ORDER ?? '';
    } catch {
      this.logger.warn('[redsys-platform] aviso con parámetros ilegibles');
      return;
    }
    const orderRow = await this.admin.platformRedsysOrder.findUnique({ where: { order } });
    if (!orderRow) {
      this.logger.warn(`[redsys-platform] pedido ${order} desconocido`);
      return;
    }
    const cfg = await this.resolved();
    if (!cfg) {
      this.logger.error('[redsys-platform] sin configuración del TPV; no se verifica');
      return;
    }
    const { valid, params } = verifyNotification(mp, sig, cfg.secretKey);
    if (!valid) {
      this.logger.error(`[redsys-platform] firma no válida en el pedido ${order}`);
      return;
    }
    const dsResponse = params.Ds_Response ?? params.DS_RESPONSE ?? '';
    const code = Number(dsResponse);
    const approved = Number.isFinite(code) && code >= 0 && code <= 99;

    // Solo la primera notificación cambia el estado (Redsys puede reenviarla).
    const { count } = await this.admin.platformRedsysOrder.updateMany({
      where: { order, status: { in: ['pending', 'replaced'] } },
      data: {
        status: approved ? 'paid' : 'failed',
        dsResponse,
        ...(approved ? { paidAt: new Date() } : {}),
      },
    });
    if (count === 0 || !approved) return;

    try {
      const payment = await this.billing.recordManualPayment({
        tenantId: orderRow.tenantId,
        provider: 'redsys',
        amount: orderRow.amountCents / 100,
        currency: 'EUR',
        durationMonths: 1,
        extendsPeriod: true,
        description: `${orderRow.payMethod === 'bizum' ? 'Bizum' : 'Tarjeta'} (Redsys) · pedido ${order}`,
      });
      await this.admin.platformRedsysOrder.update({
        where: { order },
        data: { paymentId: payment.id },
      });
    } catch (err) {
      // El dinero ya está cobrado: que no quede solo en un log.
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(`[redsys-platform] pedido ${order} cobrado pero sin registrar: ${reason}`);
      await this.admin.superAdminNotification
        .create({
          data: {
            type: 'platform_redsys.payment_unapplied',
            title: 'Pago de suscripción por Redsys sin registrar',
            body: `Se cobraron ${(orderRow.amountCents / 100).toFixed(2)} € (pedido ${order}) pero no se pudo registrar el pago: ${reason}. Regístralo a mano en la ficha del tenant.`,
            link: `/admin/tenants/${orderRow.tenantId}?tab=payments`,
          },
        })
        .catch(() => undefined);
    }
  }

  /** Cuota mensual del plan (con IVA si los precios son +IVA). */
  private async amountDue(tenantId: string): Promise<number> {
    const summary = await this.addons.billingSummary(tenantId);
    return amountToCharge(summary.planMonthly, await platformPricing(this.admin));
  }
}
