import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Public } from '../../common/decorators/public.decorator';

import { InboundMessagesService } from './inbound-messages.service';

import type { Env } from '../../config/env.schema';
import type { Request } from 'express';

/** Verifica la firma `X-Hub-Signature-256` de Meta sobre el raw body. */
function verifyMetaSignature(raw: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!appSecret) return true; // sin app secret configurado no exigimos firma (dev)
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(raw).digest('hex');
  const received = header.slice('sha256='.length);
  const a = Buffer.from(received, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

interface WabaTextMessage {
  from?: string;
  type?: string;
  text?: { body?: string };
}

/**
 * Webhook entrante de WhatsApp (Meta Cloud API). El número WABA es compartido
 * por todos los tenants → el `InboundMessagesService` resuelve el customer por
 * el teléfono del remitente. Fuera del versioning (URL estable) + `@Public`.
 */
@Public()
@Controller({ path: 'webhooks/whatsapp', version: VERSION_NEUTRAL })
export class WhatsAppInboundController {
  constructor(
    private readonly inbound: InboundMessagesService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Verificación del webhook (Meta hace GET con hub.challenge al configurarlo). */
  @Get()
  @Header('content-type', 'text/plain')
  verify(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ): string {
    const expected = this.config.get('WHATSAPP_VERIFY_TOKEN', { infer: true });
    if (mode === 'subscribe' && token && expected && token === expected) {
      return challenge ?? '';
    }
    throw new ForbiddenException('verification_failed');
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(@Req() req: Request): Promise<{ received: true }> {
    const raw = req.body as Buffer | Record<string, unknown>;
    const rawBuf = Buffer.isBuffer(raw) ? raw : Buffer.from(JSON.stringify(raw ?? {}));
    const appSecret = this.config.get('WHATSAPP_APP_SECRET', { infer: true });
    const sig = req.headers['x-hub-signature-256'];
    if (!verifyMetaSignature(rawBuf, typeof sig === 'string' ? sig : undefined, appSecret)) {
      throw new BadRequestException({ code: 'invalid_signature' });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBuf.toString('utf8'));
    } catch {
      throw new BadRequestException({ code: 'invalid_json' });
    }

    // Estructura Meta: entry[].changes[].value.messages[] (mensajes de texto).
    const entries = (payload as { entry?: unknown[] }).entry ?? [];
    for (const entry of entries) {
      const changes = (entry as { changes?: unknown[] }).changes ?? [];
      for (const change of changes) {
        const value = (change as { value?: { messages?: WabaTextMessage[] } }).value;
        for (const msg of value?.messages ?? []) {
          if (msg.type !== 'text' || !msg.from || !msg.text?.body) continue;
          // Best-effort: un remitente no resoluble no debe romper el 200.
          await this.inbound
            .record({ channel: 'whatsapp', from: msg.from, body: msg.text.body })
            .catch(() => undefined);
        }
      }
    }
    // Siempre 200: si no, Meta reintenta el lote en bucle.
    return { received: true };
  }
}
