import { timingSafeEqual } from 'node:crypto';

import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Post,
  Query,
  Req,
  UnauthorizedException,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Public } from '../../common/decorators/public.decorator';

import { parseBrevoEvents, parseResendEvent } from './email-events.parse';
import { EmailEventsService } from './email-events.service';
import { verifySvixSignature } from './svix-signature';

import type { Env } from '../../config/env.schema';
import type { Request } from 'express';

/**
 * Avisos de entrega de los proveedores de correo (entregado, rebote, error).
 * - Brevo: `POST /webhooks/email-events/brevo?token=<EMAIL_WEBHOOK_TOKEN>`
 *   (Brevo no firma los webhooks; el token va en la URL).
 * - Resend: `POST /webhooks/email-events/resend`, firma Svix con
 *   `RESEND_WEBHOOK_SECRET` (necesita el cuerpo crudo: middleware en main.ts).
 * Sin la variable correspondiente el endpoint responde 404.
 */
@Controller({ path: 'webhooks/email-events', version: VERSION_NEUTRAL })
export class EmailEventsController {
  private readonly logger = new Logger(EmailEventsController.name);

  constructor(
    private readonly service: EmailEventsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Public()
  @Post('brevo')
  @HttpCode(HttpStatus.OK)
  async brevo(@Query('token') token: string | undefined, @Body() body: unknown) {
    const expected = this.config.get('EMAIL_WEBHOOK_TOKEN', { infer: true });
    if (!expected) throw new NotFoundException();
    if (!token || !safeEqual(token, expected)) {
      this.logger.warn('Webhook de Brevo con token inválido');
      throw new UnauthorizedException();
    }
    return this.service.apply(parseBrevoEvents(body));
  }

  @Public()
  @Post('resend')
  @HttpCode(HttpStatus.OK)
  async resend(@Req() req: Request) {
    const secret = this.config.get('RESEND_WEBHOOK_SECRET', { infer: true });
    if (!secret) throw new NotFoundException();
    const raw = (req as unknown as { body: unknown }).body;
    if (!Buffer.isBuffer(raw)) {
      throw new BadRequestException('Raw body no disponible; configurar middleware');
    }
    const body = raw.toString('utf8');
    const ok = verifySvixSignature({
      secret,
      id: req.header('svix-id'),
      timestamp: req.header('svix-timestamp'),
      signature: req.header('svix-signature'),
      body,
    });
    if (!ok) {
      this.logger.warn('Webhook de Resend con firma inválida');
      throw new UnauthorizedException();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new BadRequestException('JSON inválido');
    }
    return this.service.apply(parseResendEvent(parsed));
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
