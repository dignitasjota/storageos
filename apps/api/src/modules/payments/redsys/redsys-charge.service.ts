import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaAdminService } from '../../database/prisma-admin.service';

import { RedsysSettingsService } from './redsys-settings.service';
import {
  encodeMerchantParameters,
  generateRedsysOrder,
  REDSYS_REST_ENDPOINTS,
  REDSYS_SIGNATURE_VERSION,
  signRequest,
  verifyNotification,
} from './redsys-signature';

import type { Env } from '../../../config/env.schema';
import type { ChargeResult } from '../payment-gateway.interface';

const TIMEOUT_MS = 20_000;

/**
 * Motivos de un cobro con tarjeta guardada que NO es un rechazo del banco: no
 * se avisa al inquilino de un «cobro rechazado» (puede haberse cobrado).
 */
export const REDSYS_UNCERTAIN_REASONS = [
  'redsys_unreachable',
  'redsys_invalid_response',
  'redsys_invalid_signature',
  'redsys_applied_by_notification',
] as const;

/**
 * Cobro con una tarjeta guardada en Redsys (pago por referencia): operación
 * iniciada por el comercio sin el cliente presente (MIT) por la API REST de
 * Redsys. El cobro se resuelve en el momento (autorizado o denegado).
 *
 * Simulado con `NODE_ENV=test` o `REDSYS_MODE=stub`: una referencia que empieza
 * por `stub-decline` se deniega; el resto se autoriza.
 *
 * No depende de `PaymentsService` (vive en el módulo base de Redsys): así
 * `PaymentsModule` lo puede importar sin ciclo.
 */
@Injectable()
export class RedsysChargeService {
  private readonly logger = new Logger(RedsysChargeService.name);
  private readonly stub = process.env.NODE_ENV === 'test' || process.env.REDSYS_MODE === 'stub';

  constructor(
    private readonly settings: RedsysSettingsService,
    private readonly admin: PrismaAdminService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async charge(args: {
    tenantId: string;
    invoiceId: string;
    /** Referencia de la tarjeta en Redsys (Ds_Merchant_Identifier). */
    identifier: string;
    /** Id de la operación inicial (Ds_Merchant_Cof_Txnid), si Redsys lo dio. */
    cofTxnId: string | null;
    amountCents: number;
    description: string;
  }): Promise<ChargeResult> {
    const order = generateRedsysOrder();
    const cfg = await this.settings.getResolved(args.tenantId);
    if (!cfg?.enabled || !cfg.cardOnFileEnabled) {
      return {
        gatewayPaymentId: `redsys_${order}`,
        status: 'failed',
        failureReason: 'redsys_card_on_file_disabled',
      };
    }
    // Orden registrada ANTES de cobrar (estado `charging`, distinto del
    // `pending` de los pagos con redirección): si se pierde la respuesta del
    // banco, la notificación de Redsys la aplica a la factura; si llega la
    // respuesta, se marca aquí y la notificación ya no hace nada.
    await this.admin.redsysOrder.create({
      data: {
        order,
        tenantId: args.tenantId,
        invoiceId: args.invoiceId,
        amountCents: args.amountCents,
        status: 'charging',
      },
    });
    if (this.stub) {
      return args.identifier.startsWith('stub-decline')
        ? this.resolve(order, false, '0190', 'Denegada (simulado)')
        : this.resolve(order, true, '0000');
    }
    const params: Record<string, string> = {
      DS_MERCHANT_AMOUNT: String(args.amountCents),
      DS_MERCHANT_ORDER: order,
      DS_MERCHANT_MERCHANTCODE: cfg.merchantCode,
      DS_MERCHANT_CURRENCY: '978',
      DS_MERCHANT_TRANSACTIONTYPE: '0',
      DS_MERCHANT_TERMINAL: cfg.terminal,
      DS_MERCHANT_IDENTIFIER: args.identifier,
      DS_MERCHANT_DIRECTPAYMENT: 'true',
      // Cobro iniciado por el comercio con una credencial guardada (sin SCA).
      DS_MERCHANT_EXCEP_SCA: 'MIT',
      DS_MERCHANT_COF_INI: 'N',
      DS_MERCHANT_COF_TYPE: 'R',
      ...(args.cofTxnId ? { DS_MERCHANT_COF_TXNID: args.cofTxnId } : {}),
      DS_MERCHANT_PRODUCTDESCRIPTION: args.description.slice(0, 125),
      DS_MERCHANT_MERCHANTURL: `${this.config.get('API_BASE_URL', { infer: true })}/webhooks/redsys`,
    };
    const merchantParameters = encodeMerchantParameters(params);
    const body = {
      Ds_SignatureVersion: REDSYS_SIGNATURE_VERSION,
      Ds_MerchantParameters: merchantParameters,
      Ds_Signature: signRequest(merchantParameters, order, cfg.secretKey),
    };
    let json: Record<string, string>;
    try {
      const res = await fetch(REDSYS_REST_ENDPOINTS[cfg.environment], {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      json = (await res.json()) as Record<string, string>;
    } catch (err) {
      this.logger.warn(
        `[redsys] cobro ${order} sin respuesta: ${err instanceof Error ? err.message : String(err)}`,
      );
      // La orden queda `charging`: si el banco cobró, la notificación la aplica.
      return { gatewayPaymentId: order, status: 'failed', failureReason: 'redsys_unreachable' };
    }
    if (json.errorCode) {
      return {
        gatewayPaymentId: order,
        status: 'failed',
        failureReason: `Redsys ${json.errorCode}`,
      };
    }
    if (!json.Ds_MerchantParameters || !json.Ds_Signature) {
      return {
        gatewayPaymentId: order,
        status: 'failed',
        failureReason: 'redsys_invalid_response',
      };
    }
    const { valid, params: response } = verifyNotification(
      json.Ds_MerchantParameters,
      json.Ds_Signature,
      cfg.secretKey,
    );
    if (!valid) {
      this.logger.error(`[redsys] firma inválida en la respuesta del cobro ${order}`);
      return {
        gatewayPaymentId: order,
        status: 'failed',
        failureReason: 'redsys_invalid_signature',
      };
    }
    const dsResponse = response.Ds_Response ?? response.DS_RESPONSE ?? '';
    const code = Number(dsResponse);
    const approved = Number.isFinite(code) && code >= 0 && code <= 99;
    return this.resolve(
      order,
      approved,
      dsResponse,
      approved ? undefined : `Denegada por el banco (${dsResponse || 'sin código'})`,
    );
  }

  /**
   * Cierra la orden con la respuesta del banco. Si la notificación de Redsys
   * llegó antes y ya la aplicó a la factura, el cobro no se vuelve a sumar.
   */
  private async resolve(
    order: string,
    approved: boolean,
    dsResponse: string,
    failureReason?: string,
  ): Promise<ChargeResult> {
    const { count } = await this.admin.redsysOrder.updateMany({
      where: { order, status: 'charging' },
      data: {
        status: approved ? 'paid' : 'failed',
        dsResponse,
        ...(approved ? { paidAt: new Date() } : {}),
      },
    });
    if (count === 0) {
      return {
        gatewayPaymentId: order,
        status: 'failed',
        failureReason: 'redsys_applied_by_notification',
      };
    }
    return approved
      ? { gatewayPaymentId: order, status: 'succeeded' }
      : { gatewayPaymentId: order, status: 'failed', ...(failureReason ? { failureReason } : {}) };
  }
}

/** Tarjeta que devuelve Redsys en la notificación de un pago con referencia. */
export interface RedsysSavedCard {
  identifier: string;
  cofTxnId: string | null;
  last4: string | null;
  brand: string | null;
  expMonth: number | null;
  expYear: number | null;
}

const BRANDS: Record<string, string> = {
  '1': 'visa',
  '2': 'mastercard',
  '6': 'diners',
  '7': 'private',
  '8': 'amex',
  '9': 'jcb',
  '22': 'upi',
};

/** Lee la tarjeta guardada de los parámetros de la notificación (o null). */
export function savedCardFromNotification(params: Record<string, string>): RedsysSavedCard | null {
  const identifier = params.Ds_Merchant_Identifier ?? params.DS_MERCHANT_IDENTIFIER;
  if (!identifier) return null;
  const masked = params.Ds_Card_Number ?? params.DS_CARD_NUMBER ?? '';
  const digits = masked.replace(/[^0-9]/g, '');
  // Ds_ExpiryDate llega como AAMM.
  const expiry = params.Ds_ExpiryDate ?? params.DS_EXPIRYDATE ?? '';
  const yy = /^\d{4}$/.test(expiry) ? Number(expiry.slice(0, 2)) : null;
  const mm = /^\d{4}$/.test(expiry) ? Number(expiry.slice(2, 4)) : null;
  const brandCode = params.Ds_Card_Brand ?? params.DS_CARD_BRAND ?? '';
  return {
    identifier,
    cofTxnId: params.Ds_Merchant_Cof_Txnid ?? params.DS_MERCHANT_COF_TXNID ?? null,
    last4: digits.length >= 4 ? digits.slice(-4) : null,
    brand: BRANDS[brandCode] ?? null,
    expMonth: mm && mm >= 1 && mm <= 12 ? mm : null,
    expYear: yy !== null ? 2000 + yy : null,
  };
}
