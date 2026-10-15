import { Injectable, Logger } from '@nestjs/common';

import { RedsysSettingsService } from './redsys-settings.service';
import {
  encodeMerchantParameters,
  generateRedsysOrder,
  REDSYS_REST_ENDPOINTS,
  REDSYS_SIGNATURE_VERSION,
  signRequest,
  verifyNotification,
} from './redsys-signature';

import type { ChargeResult } from '../payment-gateway.interface';

const TIMEOUT_MS = 20_000;

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

  constructor(private readonly settings: RedsysSettingsService) {}

  async charge(args: {
    tenantId: string;
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
    if (this.stub) {
      return args.identifier.startsWith('stub-decline')
        ? { gatewayPaymentId: order, status: 'failed', failureReason: 'Denegada (simulado)' }
        : { gatewayPaymentId: order, status: 'succeeded' };
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
    const code = Number(response.Ds_Response ?? response.DS_RESPONSE ?? '');
    const approved = Number.isFinite(code) && code >= 0 && code <= 99;
    return approved
      ? { gatewayPaymentId: order, status: 'succeeded' }
      : {
          gatewayPaymentId: order,
          status: 'failed',
          failureReason: `Denegada por el banco (${response.Ds_Response ?? 'sin código'})`,
        };
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
