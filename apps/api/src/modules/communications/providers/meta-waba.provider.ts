import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  WhatsAppProvider,
  type SendWhatsAppArgs,
  type SendWhatsAppResult,
} from './whatsapp-provider';

import type { Env } from '../../../config/env.schema';

/** Versión de la Graph API de Meta. */
const GRAPH_API_VERSION = 'v21.0';

interface MetaSendResponse {
  messages?: { id: string }[];
  error?: { message?: string; code?: number; error_data?: { details?: string } };
}

/**
 * Provider real de WhatsApp vía Meta WhatsApp Cloud API.
 *
 * Dos modos (la interfaz `SendWhatsAppArgs` ya los contempla):
 *   - **texto libre** (`body`): SOLO válido dentro de la ventana de servicio
 *     de 24h (mensaje iniciado por el cliente).
 *   - **plantilla aprobada** (`templateName`): obligatoria para mensajes
 *     iniciados por el negocio (dunning, avisos). La plantilla debe estar
 *     aprobada en Meta Business.
 *
 * Mismo patrón que `ResendEmailProvider`: si la API responde error, lanzamos
 * para que el outbox marque `failed` y reintente (la cola ya hace retry).
 */
@Injectable()
export class MetaWabaProvider extends WhatsAppProvider {
  private readonly logger = new Logger(MetaWabaProvider.name);
  private readonly phoneNumberId: string;
  private readonly accessToken: string;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.phoneNumberId = config.get('WHATSAPP_FROM_PHONE_ID', { infer: true });
    this.accessToken = config.get('WHATSAPP_ACCESS_TOKEN', { infer: true });
  }

  get name(): string {
    return 'meta_waba';
  }

  async send(args: SendWhatsAppArgs): Promise<SendWhatsAppResult> {
    if (!this.phoneNumberId || !this.accessToken) {
      throw new Error(
        '[whatsapp:meta] WHATSAPP_FROM_PHONE_ID y WHATSAPP_ACCESS_TOKEN son obligatorios',
      );
    }
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${this.phoneNumberId}/messages`;
    const payload = args.templateName ? buildTemplatePayload(args) : buildTextPayload(args);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw new Error(
        `[whatsapp:meta] error de red: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const json = (await res.json().catch(() => ({}))) as MetaSendResponse;
    if (!res.ok) {
      const detail = json.error?.message ?? `HTTP ${res.status}`;
      this.logger.error(`[whatsapp:meta] envio a ${args.to} fallido: ${detail}`);
      throw new Error(`[whatsapp:meta] envio fallido: ${detail}`);
    }
    return { providerMessageId: json.messages?.[0]?.id ?? null };
  }
}

/** Número en formato que acepta Meta: dígitos con prefijo de país, sin símbolos. */
function normalizePhone(to: string): string {
  return to.replace(/[^\d]/g, '');
}

function buildTextPayload(args: SendWhatsAppArgs) {
  return {
    messaging_product: 'whatsapp',
    to: normalizePhone(args.to),
    type: 'text',
    text: { body: args.body, preview_url: false },
  };
}

function buildTemplatePayload(args: SendWhatsAppArgs) {
  // Las variables posicionales del cuerpo van en orden de clave ascendente
  // ({ "1": "...", "2": "..." }). Object.values preserva ese orden para
  // claves enteras.
  const variables = args.templateVariables ?? {};
  const parameters = Object.values(variables).map((text) => ({ type: 'text', text }));
  return {
    messaging_product: 'whatsapp',
    to: normalizePhone(args.to),
    type: 'template',
    template: {
      name: args.templateName,
      language: { code: args.templateLanguage ?? 'es' },
      ...(parameters.length ? { components: [{ type: 'body', parameters }] } : {}),
    },
  };
}
