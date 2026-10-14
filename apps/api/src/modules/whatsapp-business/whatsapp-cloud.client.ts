import { Injectable, Logger } from '@nestjs/common';

const GRAPH_API_VERSION = 'v21.0';

export interface WhatsappPhoneInfo {
  displayPhone: string | null;
  verifiedName: string | null;
}

export class WhatsappCloudError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Cliente mínimo de la Cloud API de WhatsApp (Meta) con las credenciales de
 * CADA tenant (no las de la plataforma). Sin SDK, como el resto de pasarelas.
 *
 * Con `NODE_ENV=test` o `WHATSAPP_BUSINESS_MODE=stub` funciona simulado:
 * no llama a Meta, el número es `+34 600 000 000` y los envíos devuelven un
 * id `wamid.stub-…`. Así se desarrolla y se prueba sin una cuenta de Meta.
 */
@Injectable()
export class WhatsappCloudClient {
  private readonly logger = new Logger(WhatsappCloudClient.name);

  get stub(): boolean {
    return process.env.WHATSAPP_BUSINESS_MODE === 'stub' || process.env.NODE_ENV === 'test';
  }

  /** Datos públicos del número (sirve también para probar el token). */
  async getPhoneInfo(phoneNumberId: string, accessToken: string): Promise<WhatsappPhoneInfo> {
    if (this.stub) {
      if (accessToken.startsWith('invalid')) {
        throw new WhatsappCloudError('Token de acceso no válido (simulado)', 401);
      }
      return { displayPhone: '+34 600 000 000', verifiedName: 'Negocio de prueba' };
    }
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(
      phoneNumberId,
    )}?fields=display_phone_number,verified_name`;
    const json = await this.request(url, accessToken, { method: 'GET' });
    return {
      displayPhone:
        typeof json.display_phone_number === 'string' ? json.display_phone_number : null,
      verifiedName: typeof json.verified_name === 'string' ? json.verified_name : null,
    };
  }

  /** Envía un texto libre (solo dentro de la ventana de 24 h). Devuelve el wamid. */
  async sendText(args: {
    phoneNumberId: string;
    accessToken: string;
    to: string;
    body: string;
  }): Promise<{ messageId: string }> {
    if (this.stub) {
      this.logger.log(`[whatsapp:stub] → ${args.to}: ${args.body.slice(0, 60)}`);
      return { messageId: `wamid.stub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
    }
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(
      args.phoneNumberId,
    )}/messages`;
    const json = await this.request(url, args.accessToken, {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: args.to,
        type: 'text',
        text: { preview_url: true, body: args.body },
      }),
    });
    const id = (json.messages as { id?: string }[] | undefined)?.[0]?.id;
    if (!id) throw new WhatsappCloudError('Meta no devolvió el id del mensaje', 502);
    return { messageId: id };
  }

  /**
   * Mensaje con plantilla aprobada en Meta (lo único que se puede enviar
   * pasadas 24 h desde el último mensaje del contacto). `params` = variables
   * del cuerpo en orden.
   */
  async sendTemplate(args: {
    phoneNumberId: string;
    accessToken: string;
    to: string;
    name: string;
    language: string;
    params: string[];
  }): Promise<{ messageId: string }> {
    if (this.stub) {
      if (args.name.startsWith('invalid')) {
        throw new WhatsappCloudError('La plantilla no existe o no está aprobada (simulado)', 404);
      }
      this.logger.log(`[whatsapp:stub] plantilla ${args.name} → ${args.to}`);
      return {
        messageId: `wamid.stub-tpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      };
    }
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(
      args.phoneNumberId,
    )}/messages`;
    const json = await this.request(url, args.accessToken, {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: args.to,
        type: 'template',
        template: {
          name: args.name,
          language: { code: args.language },
          ...(args.params.length > 0
            ? {
                components: [
                  {
                    type: 'body',
                    parameters: args.params.map((text) => ({ type: 'text', text })),
                  },
                ],
              }
            : {}),
        },
      }),
    });
    const id = (json.messages as { id?: string }[] | undefined)?.[0]?.id;
    if (!id) throw new WhatsappCloudError('Meta no devolvió el id del mensaje', 502);
    return { messageId: id };
  }

  private async request(
    url: string,
    accessToken: string,
    init: { method: 'GET' | 'POST'; body?: string },
  ): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(init.body ? { body: init.body } : {}),
        signal: AbortSignal.timeout(10_000),
        redirect: 'manual',
      });
    } catch (err) {
      throw new WhatsappCloudError(
        `No se pudo conectar con WhatsApp: ${err instanceof Error ? err.message : String(err)}`,
        0,
      );
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const detail = (json.error as { message?: string } | undefined)?.message;
      throw new WhatsappCloudError(detail ?? `WhatsApp respondió ${res.status}`, res.status);
    }
    return json;
  }
}
