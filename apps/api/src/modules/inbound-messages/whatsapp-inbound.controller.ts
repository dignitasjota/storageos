import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  Post,
  Query,
  Req,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Public } from '../../common/decorators/public.decorator';
import { WhatsappInboxService } from '../whatsapp-business/whatsapp-inbox.service';
import {
  parseWabaMessage,
  type WabaInboundMessage,
} from '../whatsapp-business/whatsapp-message-parse';

import { InboundMessagesService } from './inbound-messages.service';

import type { Env } from '../../config/env.schema';
import type { Request } from 'express';

/** `phone_number_id` de destino de todos los cambios del aviso (sin verificar aún). */
function phoneNumberIdsOf(raw: Buffer): string[] {
  try {
    const payload = JSON.parse(raw.toString('utf8')) as {
      entry?: { changes?: { value?: { metadata?: { phone_number_id?: string } } }[] }[];
    };
    return (payload.entry ?? []).flatMap((e) =>
      (e.changes ?? [])
        .map((c) => c.value?.metadata?.phone_number_id)
        .filter((id): id is string => typeof id === 'string'),
    );
  } catch {
    return [];
  }
}

/** Verifica la firma `X-Hub-Signature-256` de Meta sobre el raw body. Se
 *  llama solo cuando hay `appSecret` configurado (ver `receive`). */
function verifyMetaSignature(raw: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(raw).digest('hex');
  const received = header.slice('sha256='.length);
  const a = Buffer.from(received, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Compara dos strings en tiempo constante (evita filtrar por timing cuánto
 *  del token coincide, aunque aquí el "secreto" es de baja entropía y de un
 *  solo uso en la config del webhook — defensa en profundidad, coherente con
 *  el resto de comparaciones de secretos del proyecto). */
function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

interface WabaStatus {
  id?: string;
  status?: string;
  errors?: { title?: string; message?: string }[];
}

interface WabaChangeValue {
  metadata?: { phone_number_id?: string };
  contacts?: { wa_id?: string; profile?: { name?: string } }[];
  messages?: WabaInboundMessage[];
  statuses?: WabaStatus[];
}

/**
 * Webhook entrante de WhatsApp (Meta Cloud API). Una sola URL para toda la app
 * de Meta: si el mensaje va al número de un tenant (extra «WhatsApp Business»,
 * se reconoce por `metadata.phone_number_id`) lo guarda su bandeja; si no, es
 * el número compartido de la plataforma y el `InboundMessagesService` resuelve
 * el inquilino por el teléfono del remitente. Fuera del versioning + `@Public`.
 */
@Public()
@Controller({ path: 'webhooks/whatsapp', version: VERSION_NEUTRAL })
export class WhatsAppInboundController {
  private readonly logger = new Logger(WhatsAppInboundController.name);

  constructor(
    private readonly inbound: InboundMessagesService,
    private readonly inbox: WhatsappInboxService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Verificación del webhook (Meta hace GET con hub.challenge al configurarlo). */
  @Get()
  @Header('content-type', 'text/plain')
  async verify(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ): Promise<string> {
    const expected = this.config.get('WHATSAPP_VERIFY_TOKEN', { infer: true });
    if (mode === 'subscribe' && token) {
      if (expected && timingSafeEqualString(token, expected)) return challenge ?? '';
      // App de Meta propia del tenant: su token de verificación.
      if (await this.inbox.isTenantVerifyToken(token)) return challenge ?? '';
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
    const signature = typeof sig === 'string' ? sig : undefined;
    let verified = !!appSecret && verifyMetaSignature(rawBuf, signature, appSecret);
    if (!verified && signature) {
      // Número conectado con la app de Meta propia del tenant: el aviso viene
      // firmado con el secreto de esa app (se busca por el número de destino).
      const tenantSecret = await this.inbox.appSecretForPhoneNumberIds(phoneNumberIdsOf(rawBuf));
      verified = !!tenantSecret && verifyMetaSignature(rawBuf, signature, tenantSecret);
    }
    if (!verified) {
      if (appSecret) throw new BadRequestException({ code: 'invalid_signature' });
      // Sin secret configurado, el bypass SOLO se tolera en dev/test con el
      // provider `stub` (sin integración real de WhatsApp conectada). En
      // cualquier otro caso fallamos cerrado en vez de aceptar mensajes sin
      // firmar (evita que cualquiera inyecte un WhatsApp falso).
      const provider = this.config.get('WHATSAPP_PROVIDER', { infer: true });
      const nodeEnv = this.config.get('NODE_ENV', { infer: true });
      if (provider !== 'stub' || nodeEnv === 'production') {
        throw new ForbiddenException({ code: 'whatsapp_app_secret_not_configured' });
      }
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBuf.toString('utf8'));
    } catch {
      throw new BadRequestException({ code: 'invalid_json' });
    }

    // Estructura Meta: entry[].changes[].value.messages[] (texto, archivos, ubicación…).
    let failed = false;
    const entries = (payload as { entry?: unknown[] }).entry ?? [];
    for (const entry of entries) {
      const changes = (entry as { changes?: unknown[] }).changes ?? [];
      for (const change of changes) {
        const value = (change as { value?: WabaChangeValue }).value;
        const phoneNumberId = value?.metadata?.phone_number_id ?? null;
        for (const msg of value?.messages ?? []) {
          const parsed = msg.from ? parseWabaMessage(msg) : null;
          if (!msg.from || !parsed) continue;
          // Si falla al guardar, se sigue con el resto y al final se responde
          // 500: Meta reenvía el lote y los ya guardados se descartan por su id.
          const handled =
            phoneNumberId && msg.id
              ? await this.inbox
                  .handleInbound({
                    phoneNumberId,
                    from: msg.from,
                    profileName:
                      value?.contacts?.find((c) => c.wa_id === msg.from)?.profile?.name ?? null,
                    waMessageId: msg.id,
                    body: parsed.body,
                    media: parsed.media,
                    receivedAt: msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : new Date(),
                  })
                  .catch((err: unknown) => {
                    failed = true;
                    this.logger.error(
                      `whatsapp: no se pudo guardar el mensaje ${msg.id}: ${
                        err instanceof Error ? err.message : String(err)
                      }`,
                    );
                    return true;
                  })
              : false;
          if (handled) continue;
          await this.inbound
            .record({ channel: 'whatsapp', from: msg.from, body: parsed.body })
            .catch(() => undefined);
        }
        for (const st of value?.statuses ?? []) {
          if (!st.id || !st.status) continue;
          await this.inbox
            .handleStatus({
              waMessageId: st.id,
              status: st.status,
              error: st.errors?.[0]?.message ?? st.errors?.[0]?.title ?? null,
            })
            .catch(() => undefined);
        }
      }
    }
    if (failed) {
      throw new InternalServerErrorException({ code: 'whatsapp_store_failed' });
    }
    return { received: true };
  }
}
