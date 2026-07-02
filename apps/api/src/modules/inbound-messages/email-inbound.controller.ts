import { timingSafeEqual } from 'node:crypto';

import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailInboundSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { InboundMessagesService } from './inbound-messages.service';

import type { Env } from '../../config/env.schema';

class EmailInboundDto extends createZodDto(EmailInboundSchema) {}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Inbound de email: un proveedor de routing entrante (Resend/Brevo/forwarding)
 * hace POST con el correo del inquilino ya parseado. Autenticado con un secret
 * compartido (`EMAIL_INBOUND_SECRET`) en el header `X-Inbound-Secret`. El
 * `InboundMessagesService` resuelve el customer por el email del remitente.
 */
@Public()
@Controller({ path: 'webhooks/email-inbound', version: VERSION_NEUTRAL })
export class EmailInboundController {
  constructor(
    private readonly inbound: InboundMessagesService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Body() body: EmailInboundDto,
    @Headers('x-inbound-secret') secret?: string,
  ): Promise<{ received: boolean }> {
    const expected = this.config.get('EMAIL_INBOUND_SECRET', { infer: true });
    if (!expected || !secret || !safeEqual(secret, expected)) {
      throw new ForbiddenException({ code: 'invalid_inbound_secret' });
    }
    const received = await this.inbound.record({
      channel: 'email',
      from: body.from,
      body: body.text,
    });
    return { received };
  }
}
