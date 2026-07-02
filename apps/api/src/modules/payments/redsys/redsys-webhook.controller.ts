import { Controller, HttpCode, HttpStatus, Post, Req, VERSION_NEUTRAL } from '@nestjs/common';

import { Public } from '../../../common/decorators/public.decorator';

import { RedsysService } from './redsys.service';

import type { Request } from 'express';

interface RedsysNotification {
  Ds_SignatureVersion?: string | undefined;
  Ds_MerchantParameters?: string | undefined;
  Ds_Signature?: string | undefined;
}

/** Extrae los 3 campos como strings, descartando cualquier otro tipo. */
function pickFields(src: Record<string, unknown>): RedsysNotification {
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  return {
    Ds_SignatureVersion: str(src['Ds_SignatureVersion']),
    Ds_MerchantParameters: str(src['Ds_MerchantParameters']),
    Ds_Signature: str(src['Ds_Signature']),
  };
}

/**
 * Notificación servidor-a-servidor de Redsys (`Ds_Merchant_MerchantURL`).
 * Llega como `application/x-www-form-urlencoded`. Fuera del versioning para
 * que la URL `/webhooks/redsys` sea estable.
 *
 * Defensa en profundidad (auditoría 2026-07): igual que Stripe/GoCardless, el
 * body llega RAW (middleware en `main.ts`) y se parsea aquí de forma estricta
 * según content-type, sin pasar por el parser extendido de qs (que puede
 * producir arrays/objetos anidados). Solo se aceptan strings planos.
 */
@Public()
@Controller({ path: 'webhooks/redsys', version: VERSION_NEUTRAL })
export class RedsysWebhookController {
  constructor(private readonly redsys: RedsysService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async handle(@Req() req: Request): Promise<{ received: true }> {
    const body = req.body as Buffer | Record<string, unknown>;
    let fields: RedsysNotification;
    if (Buffer.isBuffer(body)) {
      const text = body.toString('utf8');
      const contentType = req.headers['content-type'] ?? '';
      if (contentType.includes('application/json')) {
        // Los tests (supertest) postean JSON; Redsys real postea urlencoded.
        fields = pickFields(JSON.parse(text) as Record<string, unknown>);
      } else {
        const params = new URLSearchParams(text);
        fields = {
          Ds_SignatureVersion: params.get('Ds_SignatureVersion') ?? undefined,
          Ds_MerchantParameters: params.get('Ds_MerchantParameters') ?? undefined,
          Ds_Signature: params.get('Ds_Signature') ?? undefined,
        };
      }
    } else {
      // Fallback si el middleware raw no está montado (p. ej. otro entorno).
      fields = pickFields(body ?? {});
    }
    await this.redsys.handleNotification(fields);
    return { received: true };
  }
}
