import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  VERSION_NEUTRAL,
} from '@nestjs/common';

import { Public } from '../../../common/decorators/public.decorator';

import { verifyGoCardlessSignature } from './gocardless-client';
import { GoCardlessSettingsService } from './gocardless-settings.service';

import type { Request } from 'express';

/**
 * Webhook público de GoCardless. La URL lleva el `:tenantId` porque GoCardless
 * no incluye el tenant en el payload y cada tenant tiene su propio webhook
 * secret: cada uno configura en su dashboard la URL
 * `/webhooks/gocardless/<su-tenant-id>`. Necesita el raw body para verificar la
 * firma (`Webhook-Signature`); se registra `express.raw` en `main.ts`.
 *
 * Fase 1: recepción + verificación de firma. El despacho de eventos (mandates /
 * payments → PaymentsService) llega con el cobro por GoCardless (fase posterior).
 */
@Controller({ path: 'webhooks', version: VERSION_NEUTRAL })
export class GoCardlessWebhookController {
  private readonly logger = new Logger(GoCardlessWebhookController.name);

  constructor(private readonly settings: GoCardlessSettingsService) {}

  @Public()
  @Post('gocardless/:tenantId')
  @HttpCode(HttpStatus.OK)
  async handle(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Req() req: Request,
  ): Promise<{ received: true }> {
    const signature = req.header('webhook-signature');
    const rawBody = (req as unknown as { body: Buffer }).body;
    if (!Buffer.isBuffer(rawBody)) {
      throw new BadRequestException('Raw body no disponible; configurar middleware');
    }

    const resolved = await this.settings.getResolved(tenantId);
    if (!resolved?.webhookSecret) {
      // Tenant desconocido o sin webhook secret configurado.
      throw new BadRequestException('Webhook de GoCardless no configurado');
    }
    if (!verifyGoCardlessSignature(rawBody, signature, resolved.webhookSecret)) {
      this.logger.warn(`Firma de GoCardless inválida (tenant ${tenantId})`);
      throw new BadRequestException('Firma inválida');
    }

    const events = (JSON.parse(rawBody.toString('utf8')) as { events?: { action?: string }[] })
      .events;
    this.logger.log(
      `Webhook GoCardless verificado (tenant ${tenantId}): ${events?.length ?? 0} evento(s)`,
    );
    // El despacho de mandates/payments a PaymentsService llega en la fase de cobro.
    return { received: true };
  }
}
