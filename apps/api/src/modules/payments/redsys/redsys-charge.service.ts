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
import type { RedsysTestResultDto } from '@storageos/shared';

// Códigos del glosario oficial de Redsys (manual de conexión por Web Service).
/** SIS0041 «Error en el cálculo de la HASH», SIS0042 «La firma enviada no es correcta». */
const REDSYS_BAD_KEY_CODES = new Set(['SIS0041', 'SIS0042']);
/** SIS0026 «No existe el comercio / terminal enviado», SIS0028 «Comercio / terminal está dado de baja». */
const REDSYS_BAD_MERCHANT_CODES = new Set(['SIS0026', 'SIS0028']);
/**
 * SIS0054 «No existe operación sobre la que realizar la devolución» y SIS0055
 * «Existe más de un pago con el mismo número de pedido»: Redsys ya comprobó el
 * comercio, el terminal y la firma, así que los datos son correctos.
 */
const REDSYS_NOT_FOUND_CODES = new Set(['SIS0054', 'SIS0055']);

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
 * por `stub-decline` se deniega, por `stub-noresponse` se queda sin respuesta;
 * el resto se autoriza.
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

  /** ¿Se pueden cobrar ahora las tarjetas guardadas en Redsys (pago por referencia)? */
  async available(tenantId: string): Promise<boolean> {
    const cfg = await this.settings.getResolved(tenantId);
    return !!cfg?.enabled && !!cfg.cardOnFileEnabled;
  }

  /**
   * «Probar TPV»: pide a Redsys la devolución de 0,01 € de una operación que
   * no existe. No mueve dinero: si el comercio, el terminal y la clave están
   * bien, Redsys responde que no encuentra la operación; si no, da un error de
   * firma o de comercio distinto.
   *
   * Simulado con `NODE_ENV=test` o `REDSYS_MODE=stub`: una clave que empieza
   * por `invalid` da error de firma y el comercio `000000000`, de comercio.
   */
  async testCredentials(cfg: {
    merchantCode: string;
    terminal: string;
    secretKey: string;
    environment: 'test' | 'live';
  }): Promise<RedsysTestResultDto> {
    if (!/^\d{1,9}$/.test(cfg.merchantCode) || !/^\d{1,3}$/.test(cfg.terminal)) {
      return {
        ok: false,
        status: 'bad_merchant',
        code: null,
        message:
          'El código de comercio (FUC) son 9 cifras y el terminal, de 1 a 3 cifras. Revisa los datos que te dio el banco.',
      };
    }
    const keyBytes = Buffer.from(cfg.secretKey, 'base64').length;
    if (keyBytes !== 24) {
      return {
        ok: false,
        status: 'bad_key',
        code: null,
        message:
          'La clave secreta no tiene el formato de Redsys (32 caracteres, la «clave SHA-256» del panel del TPV).',
      };
    }
    if (this.stub) {
      if (cfg.secretKey.startsWith('invalid')) {
        return this.testOutcome('SIS0042');
      }
      if (cfg.merchantCode === '000000000') return this.testOutcome('SIS0026');
      return this.testOutcome('SIS0054');
    }
    const order = generateRedsysOrder();
    const params: Record<string, string> = {
      DS_MERCHANT_AMOUNT: '1',
      DS_MERCHANT_ORDER: order,
      DS_MERCHANT_MERCHANTCODE: cfg.merchantCode,
      DS_MERCHANT_CURRENCY: '978',
      // Devolución: sobre una operación que no existe, Redsys la rechaza siempre.
      DS_MERCHANT_TRANSACTIONTYPE: '3',
      DS_MERCHANT_TERMINAL: cfg.terminal,
    };
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
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      json = (await res.json()) as Record<string, string>;
    } catch (err) {
      this.logger.warn(
        `[redsys] prueba del TPV sin respuesta: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        ok: false,
        status: 'unreachable',
        code: null,
        message: 'No hemos podido conectar con Redsys. Prueba de nuevo en unos minutos.',
      };
    }
    if (json.errorCode) return this.testOutcome(json.errorCode);
    // Una respuesta firmada: la clave es buena si la firma cuadra.
    if (json.Ds_MerchantParameters && json.Ds_Signature) {
      const { valid } = verifyNotification(
        json.Ds_MerchantParameters,
        json.Ds_Signature,
        cfg.secretKey,
      );
      return valid
        ? {
            ok: true,
            status: 'ok',
            code: null,
            message: 'Los datos del TPV son correctos: Redsys ha aceptado la firma.',
          }
        : this.testOutcome('SIS0042');
    }
    return {
      ok: false,
      status: 'unknown',
      code: null,
      message: 'Redsys ha respondido algo inesperado. Revisa los datos con tu banco.',
    };
  }

  private testOutcome(code: string): RedsysTestResultDto {
    if (REDSYS_NOT_FOUND_CODES.has(code)) {
      return {
        ok: true,
        status: 'ok',
        code,
        message:
          'Los datos del TPV son correctos: Redsys ha reconocido el comercio, el terminal y la clave. No se ha cobrado nada.',
      };
    }
    if (REDSYS_BAD_KEY_CODES.has(code)) {
      return {
        ok: false,
        status: 'bad_key',
        code,
        message:
          'Redsys no acepta la firma: la clave secreta no es la de este comercio y entorno (pruebas y producción tienen claves distintas).',
      };
    }
    if (REDSYS_BAD_MERCHANT_CODES.has(code)) {
      return {
        ok: false,
        status: 'bad_merchant',
        code,
        message:
          'Redsys no encuentra el comercio o el terminal, o están dados de baja. Revisa el código de comercio, el terminal y el entorno.',
      };
    }
    return {
      ok: false,
      status: 'unknown',
      code,
      message: `Redsys ha respondido con el código ${code}. No podemos asegurar que los datos sean correctos: consúltalo con tu banco.`,
    };
  }

  async charge(args: {
    tenantId: string;
    invoiceId: string;
    /** Referencia de la tarjeta en Redsys (Ds_Merchant_Identifier). */
    identifier: string;
    /** Id de la operación inicial (Ds_Merchant_Cof_Txnid), si Redsys lo dio. */
    cofTxnId: string | null;
    amountCents: number;
    description: string;
    /** Pagos ya reservados para este cobro (la factura y su fianza). */
    paymentIds?: string[];
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
    // Los pagos reservados llevan ya el número de orden: si la notificación de
    // Redsys llega antes que la respuesta, resuelve esos mismos pagos (antes
    // creaba otros y los reservados quedaban como fallidos en el historial).
    if (args.paymentIds && args.paymentIds.length > 0) {
      await this.admin.payment.updateMany({
        where: { id: { in: args.paymentIds }, status: 'processing' },
        data: { gatewayPaymentId: order },
      });
    }
    if (this.stub) {
      // `stub-noresponse`: el banco no contesta (la orden queda `charging`).
      if (args.identifier.startsWith('stub-noresponse')) {
        return { gatewayPaymentId: order, status: 'unknown', failureReason: 'redsys_unreachable' };
      }
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
      // La orden queda `charging` y el pago en curso: si el banco cobró, la
      // notificación lo aplica; si no llega, el repaso de cobros lo cierra.
      return { gatewayPaymentId: order, status: 'unknown', failureReason: 'redsys_unreachable' };
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
        status: 'unknown',
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
        status: 'unknown',
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
