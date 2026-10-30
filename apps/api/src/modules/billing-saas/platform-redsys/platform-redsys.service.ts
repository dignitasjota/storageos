import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CryptoService } from '../../../common/crypto/crypto.service';
import { toCents } from '../../../common/money';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { savedCardFromNotification } from '../../payments/redsys/redsys-charge.service';
import {
  decodeMerchantParameters,
  encodeMerchantParameters,
  generateRedsysOrder,
  REDSYS_ENDPOINTS,
  REDSYS_REST_ENDPOINTS,
  REDSYS_SIGNATURE_VERSION,
  signRequest,
  verifyNotification,
} from '../../payments/redsys/redsys-signature';
import { BillingSaasService } from '../billing-saas.service';
import { periodsOwed } from '../platform-due';
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

/** Intentos del cobro automático por periodo, y días entre uno y otro. */
export const AUTO_CHARGE_MAX_ATTEMPTS = 3;
export const AUTO_CHARGE_RETRY_DAYS = 2;
const DAY_MS = 86_400_000;
const REST_TIMEOUT_MS = 20_000;

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
  /** Sin red en tests: una referencia `stub-decline…` se deniega, `stub-noresponse…` no contesta. */
  private readonly stub = process.env.NODE_ENV === 'test' || process.env.REDSYS_MODE === 'stub';

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
    const [cfg, sub, tenant, card] = await Promise.all([
      this.resolved(),
      this.admin.tenantSubscription.findUnique({
        where: { tenantId },
        include: { plan: { select: { name: true, priceMonthly: true } } },
      }),
      this.admin.tenant.findUnique({ where: { id: tenantId }, select: { billingExempt: true } }),
      this.admin.platformRedsysCard.findUnique({ where: { tenantId } }),
    ]);
    const base: TenantRedsysPaymentOptionsDto = {
      available: false,
      cardEnabled: false,
      bizumEnabled: false,
      amount: 0,
      currency: 'EUR',
      monthsOwed: 1,
      currentPeriodEnd: sub?.currentPeriodEnd.toISOString() ?? null,
      pastDue: sub?.status === 'past_due',
      planName: sub?.plan.name ?? null,
      cardOnFileAvailable: false,
      autoCharge: false,
      savedCard: card
        ? {
            last4: card.last4,
            brand: card.brand,
            expMonth: card.expMonth,
            expYear: card.expYear,
            lastError: card.lastError,
          }
        : null,
      reason: null,
    };
    if (!cfg?.enabled) return { ...base, reason: 'not_configured' };
    if (!sub) return { ...base, reason: 'no_subscription' };
    if (tenant?.billingExempt) return { ...base, reason: 'exempt' };
    if (sub.billingMode !== 'manual' && sub.billingMode !== 'redsys') {
      return { ...base, reason: 'not_manual' };
    }
    const amount = await this.amountDue(tenantId, sub.billingMode);
    if (amount <= 0) return { ...base, reason: 'free_plan' };
    const now = new Date();
    const monthsOwed =
      sub.currentPeriodEnd < now ? periodsOwed(sub.currentPeriodEnd, now, 1, false) : 1;
    return {
      ...base,
      available: true,
      cardEnabled: true,
      bizumEnabled: cfg.bizumEnabled,
      cardOnFileAvailable: cfg.cardOnFileEnabled,
      autoCharge: sub.billingMode === 'redsys' && !!card,
      amount,
      monthsOwed,
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
    opts: {
      payMethod?: RedsysPayMethod | undefined;
      saveCard?: boolean | undefined;
      /** Meses que paga de una vez (por defecto, uno). */
      months?: number | undefined;
    },
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
    const months = Math.min(12, Math.max(1, Math.floor(opts.months ?? 1)));
    const amountCents = toCents(options.amount) * months;
    const payMethod = opts.payMethod ?? null;
    // Guardar la tarjeta para cobrar sola cada mes (solo tarjeta, si el banco lo permite).
    const saveCard = !!opts.saveCard && cfg.cardOnFileEnabled && payMethod !== 'bizum';
    const orderRow = await this.admin.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`platform-redsys:${tenantId}`}))`;
      const existing = await tx.platformRedsysOrder.findFirst({
        where: { tenantId, status: 'pending' },
        orderBy: { createdAt: 'desc' },
      });
      if (
        existing &&
        existing.amountCents === amountCents &&
        existing.payMethod === payMethod &&
        existing.saveCard === saveCard &&
        existing.months === months
      ) {
        return existing;
      }
      if (existing) {
        await tx.platformRedsysOrder.update({
          where: { order: existing.order },
          data: { status: 'replaced' },
        });
      }
      return tx.platformRedsysOrder.create({
        data: {
          order: generateRedsysOrder(),
          tenantId,
          amountCents,
          payMethod,
          saveCard,
          months,
          status: 'pending',
        },
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
      DS_MERCHANT_PRODUCTDESCRIPTION: `Suscripción TrasterOS · ${options.planName ?? ''}${
        orderRow.months > 1 ? ` · ${orderRow.months} meses` : ''
      }`
        .trim()
        .slice(0, 125),
      // 'z' = Bizum, 'C' = tarjeta; sin el campo el TPV ofrece lo que tenga activo.
      ...(payMethod ? { DS_MERCHANT_PAYMETHODS: payMethod === 'bizum' ? 'z' : 'C' } : {}),
      // Pago por referencia: Redsys guarda la tarjeta y la devuelve en el aviso.
      ...(orderRow.saveCard
        ? {
            DS_MERCHANT_PAYMETHODS: 'C',
            DS_MERCHANT_IDENTIFIER: 'REQUIRED',
            DS_MERCHANT_COF_INI: 'S',
            DS_MERCHANT_COF_TYPE: 'R',
          }
        : {}),
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
    // `charging` = cobro automático cuya respuesta aún no ha llegado.
    const { count } = await this.admin.platformRedsysOrder.updateMany({
      where: { order, status: { in: ['pending', 'replaced', 'charging'] } },
      data: {
        status: approved ? 'paid' : 'failed',
        dsResponse,
        ...(approved ? { paidAt: new Date() } : {}),
      },
    });
    if (count === 0) return;
    if (!approved) {
      if (orderRow.kind === 'auto')
        await this.autoChargeFailed(orderRow.tenantId, `Redsys ${dsResponse}`);
      return;
    }
    if (orderRow.saveCard) await this.saveCard(orderRow.tenantId, params);
    await this.recordPayment(orderRow);
  }

  /** Registra el pago de la suscripción de una orden cobrada (una sola vez). */
  private async recordPayment(orderRow: {
    order: string;
    tenantId: string;
    amountCents: number;
    payMethod: string | null;
    kind: string;
    months: number;
  }): Promise<void> {
    const order = orderRow.order;
    const how =
      orderRow.kind === 'auto'
        ? 'Cobro automático con tarjeta (Redsys)'
        : `${orderRow.payMethod === 'bizum' ? 'Bizum' : 'Tarjeta'} (Redsys)`;
    try {
      const payment = await this.billing.recordManualPayment({
        tenantId: orderRow.tenantId,
        provider: 'redsys',
        amount: orderRow.amountCents / 100,
        currency: 'EUR',
        durationMonths: orderRow.months,
        extendsPeriod: true,
        description: `${how}${orderRow.months > 1 ? ` · ${orderRow.months} meses` : ''} · pedido ${order}`,
      });
      await this.admin.platformRedsysOrder.update({
        where: { order },
        data: { paymentId: payment.id },
      });
      if (orderRow.kind === 'auto') {
        await this.admin.platformRedsysCard.updateMany({
          where: { tenantId: orderRow.tenantId },
          data: { lastError: null },
        });
      }
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

  /**
   * Guarda la tarjeta que devuelve Redsys y pasa la suscripción a cobro
   * automático (si se pagaba a mano). Nunca rompe la confirmación del pago.
   */
  private async saveCard(tenantId: string, params: Record<string, string>): Promise<void> {
    const card = savedCardFromNotification(params);
    if (!card) {
      this.logger.warn(`[redsys-platform] pago con «guardar tarjeta» sin referencia (${tenantId})`);
      return;
    }
    try {
      const data = {
        identifierEncrypted: this.crypto.encryptString(card.identifier, tenantId),
        cofTxnId: card.cofTxnId,
        last4: card.last4,
        brand: card.brand,
        expMonth: card.expMonth,
        expYear: card.expYear,
        lastError: null,
      };
      await this.admin.platformRedsysCard.upsert({
        where: { tenantId },
        create: { tenantId, ...data },
        update: data,
      });
      await this.admin.tenantSubscription.updateMany({
        where: { tenantId, billingMode: 'manual' },
        data: { billingMode: 'redsys' },
      });
    } catch (err) {
      this.logger.warn(
        `[redsys-platform] no se pudo guardar la tarjeta de ${tenantId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** El tenant deja de pagar con la tarjeta guardada: vuelve al pago a mano. */
  async disableAutoCharge(tenantId: string): Promise<void> {
    await this.admin.$transaction([
      this.admin.platformRedsysCard.deleteMany({ where: { tenantId } }),
      this.admin.tenantSubscription.updateMany({
        where: { tenantId, billingMode: 'redsys' },
        data: { billingMode: 'manual' },
      }),
    ]);
  }

  // --------------------------- cobro automático ---------------------------

  /**
   * Cobra con la tarjeta guardada las suscripciones en modo `redsys` cuyo
   * periodo ha vencido. Hasta 3 intentos por periodo, separados 2 días; un
   * cobro sin respuesta queda en curso y lo resuelve el aviso de Redsys.
   */
  async runAutoCharges(now = new Date()): Promise<{ charged: number; failed: number }> {
    const cfg = await this.resolved();
    if (!cfg?.enabled || !cfg.cardOnFileEnabled) return { charged: 0, failed: 0 };
    const subs = await this.admin.tenantSubscription.findMany({
      where: {
        billingMode: 'redsys',
        status: { in: ['active', 'past_due'] },
        currentPeriodEnd: { lte: now },
        plan: { priceMonthly: { gt: 0 } },
        tenant: { deletedAt: null, billingExempt: false, platformRedsysCard: { isNot: null } },
      },
      select: { tenantId: true, currentPeriodEnd: true },
    });
    let charged = 0;
    let failed = 0;
    for (const sub of subs) {
      const since = new Date(sub.currentPeriodEnd.getTime() - DAY_MS);
      const attempts = await this.admin.platformRedsysOrder.findMany({
        where: { tenantId: sub.tenantId, kind: 'auto', createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        select: { status: true, createdAt: true },
      });
      if (attempts.some((a) => a.status === 'charging')) continue;
      if (attempts.length >= AUTO_CHARGE_MAX_ATTEMPTS) continue;
      const last = attempts[0];
      if (last && now.getTime() - last.createdAt.getTime() < AUTO_CHARGE_RETRY_DAYS * DAY_MS) {
        continue;
      }
      const result = await this.chargeSavedCard(sub.tenantId, cfg);
      if (result === 'paid') charged++;
      if (result === 'failed') failed++;
    }
    return { charged, failed };
  }

  /** Un cobro con la tarjeta guardada (operación sin el cliente, MIT). */
  async chargeSavedCard(
    tenantId: string,
    cfg: ResolvedSettings,
  ): Promise<'paid' | 'failed' | 'unknown'> {
    const card = await this.admin.platformRedsysCard.findUnique({ where: { tenantId } });
    if (!card) return 'failed';
    const amountCents = toCents(await this.amountDue(tenantId, 'redsys'));
    if (amountCents <= 0) return 'failed';
    const identifier = this.crypto.decryptString(card.identifierEncrypted, tenantId);
    const order = generateRedsysOrder();
    // Orden registrada ANTES de cobrar: si se pierde la respuesta, el aviso de
    // Redsys la aplica; si llega la respuesta, el aviso posterior no hace nada.
    const orderRow = await this.admin.platformRedsysOrder.create({
      data: { order, tenantId, amountCents, status: 'charging', kind: 'auto', payMethod: 'card' },
    });

    let approved: boolean | null;
    let dsResponse = '';
    if (this.stub) {
      approved = identifier.startsWith('stub-noresponse')
        ? null
        : !identifier.startsWith('stub-decline');
      dsResponse = approved ? '0000' : '0190';
    } else {
      const res = await this.callRest(cfg, {
        DS_MERCHANT_AMOUNT: String(amountCents),
        DS_MERCHANT_ORDER: order,
        DS_MERCHANT_MERCHANTCODE: cfg.merchantCode,
        DS_MERCHANT_CURRENCY: '978',
        DS_MERCHANT_TRANSACTIONTYPE: '0',
        DS_MERCHANT_TERMINAL: cfg.terminal,
        DS_MERCHANT_IDENTIFIER: identifier,
        DS_MERCHANT_DIRECTPAYMENT: 'true',
        DS_MERCHANT_EXCEP_SCA: 'MIT',
        DS_MERCHANT_COF_INI: 'N',
        DS_MERCHANT_COF_TYPE: 'R',
        ...(card.cofTxnId ? { DS_MERCHANT_COF_TXNID: card.cofTxnId } : {}),
        DS_MERCHANT_PRODUCTDESCRIPTION: 'Suscripción TrasterOS',
        DS_MERCHANT_MERCHANTURL: `${this.config.get('API_BASE_URL', { infer: true })}/webhooks/redsys/platform`,
      });
      approved = res.approved;
      dsResponse = res.dsResponse;
    }
    if (approved === null) return 'unknown';

    const { count } = await this.admin.platformRedsysOrder.updateMany({
      where: { order, status: 'charging' },
      data: {
        status: approved ? 'paid' : 'failed',
        dsResponse,
        ...(approved ? { paidAt: new Date() } : {}),
      },
    });
    // El aviso de Redsys llegó antes y ya lo aplicó.
    if (count === 0) return approved ? 'paid' : 'failed';
    if (approved) {
      await this.recordPayment(orderRow);
      return 'paid';
    }
    await this.autoChargeFailed(tenantId, `Denegada por el banco (${dsResponse || 'sin código'})`);
    return 'failed';
  }

  /** Anota el rechazo; al último intento del periodo, avisa al super admin. */
  private async autoChargeFailed(tenantId: string, reason: string): Promise<void> {
    await this.admin.platformRedsysCard.updateMany({
      where: { tenantId },
      data: { lastError: reason },
    });
    const sub = await this.admin.tenantSubscription.findUnique({
      where: { tenantId },
      select: { currentPeriodEnd: true },
    });
    if (!sub) return;
    const failures = await this.admin.platformRedsysOrder.count({
      where: {
        tenantId,
        kind: 'auto',
        status: 'failed',
        createdAt: { gte: new Date(sub.currentPeriodEnd.getTime() - DAY_MS) },
      },
    });
    if (failures < AUTO_CHARGE_MAX_ATTEMPTS) return;
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    await this.admin.superAdminNotification
      .create({
        data: {
          type: 'platform_redsys.auto_charge_failed',
          title: `No se pudo cobrar la suscripción de ${tenant?.name ?? 'un tenant'}`,
          body: `Tres intentos con la tarjeta guardada rechazados (${reason}). Queda en impago hasta que pague o cambie la tarjeta.`,
          link: `/admin/tenants/${tenantId}?tab=payments`,
        },
      })
      .catch(() => undefined);
  }

  /** Petición a la API REST de Redsys; `approved` null = sin respuesta fiable. */
  private async callRest(
    cfg: ResolvedSettings,
    params: Record<string, string>,
  ): Promise<{ approved: boolean | null; dsResponse: string }> {
    const order = params.DS_MERCHANT_ORDER ?? '';
    const merchantParameters = encodeMerchantParameters(params);
    let json: Record<string, string>;
    try {
      const res = await fetch(REDSYS_REST_ENDPOINTS[cfg.environment], {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          Ds_SignatureVersion: REDSYS_SIGNATURE_VERSION,
          Ds_MerchantParameters: merchantParameters,
          Ds_Signature: signRequest(merchantParameters, order, cfg.secretKey),
        }),
        signal: AbortSignal.timeout(REST_TIMEOUT_MS),
      });
      json = (await res.json()) as Record<string, string>;
    } catch (err) {
      this.logger.warn(
        `[redsys-platform] cobro ${order} sin respuesta: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { approved: null, dsResponse: '' };
    }
    if (json.errorCode) return { approved: false, dsResponse: json.errorCode };
    if (!json.Ds_MerchantParameters || !json.Ds_Signature)
      return { approved: null, dsResponse: '' };
    const { valid, params: response } = verifyNotification(
      json.Ds_MerchantParameters,
      json.Ds_Signature,
      cfg.secretKey,
    );
    if (!valid) return { approved: null, dsResponse: '' };
    const dsResponse = response.Ds_Response ?? response.DS_RESPONSE ?? '';
    const code = Number(dsResponse);
    return { approved: Number.isFinite(code) && code >= 0 && code <= 99, dsResponse };
  }

  /**
   * Cuota de un mes (con IVA si los precios son +IVA). Con el cobro automático
   * con tarjeta (modo `redsys`) se cobran también los extras que no van por
   * Stripe, como en la remesa SEPA; pagando a mano, solo el plan (cada extra
   * tiene su propio cobro).
   */
  private async amountDue(tenantId: string, billingMode: string): Promise<number> {
    const summary = await this.addons.billingSummary(tenantId);
    const addons =
      billingMode === 'redsys'
        ? summary.addons
            .filter((a) => !a.suspended && a.billingMode !== 'stripe')
            .reduce((sum, a) => sum + a.lineTotal, 0)
        : 0;
    return amountToCharge(summary.planMonthly + addons, await platformPricing(this.admin));
  }
}
