import { Injectable, Logger } from '@nestjs/common';
import { templateParamCount, type WhatsappTemplateDto } from '@storageos/shared';

const GRAPH_API_VERSION = 'v21.0';
/** Tamaño máximo de un archivo recibido que se guarda (el resto se deja sin copia). */
export const WHATSAPP_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
/** JPEG mínimo que devuelve el modo simulado. */
const STUB_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9,
]);

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

  /** Plantillas aprobadas de la cuenta de WhatsApp Business (WABA). */
  async listTemplates(wabaId: string, accessToken: string): Promise<WhatsappTemplateDto[]> {
    if (this.stub) {
      return [
        {
          name: 'recordatorio_reserva',
          language: 'es',
          category: 'UTILITY',
          body: 'Hola {{1}}, tu trastero sigue reservado. Termina la reserva aquí: {{2}}',
          paramCount: 2,
        },
        {
          name: 'seguimiento_contacto',
          language: 'es',
          category: 'MARKETING',
          body: 'Hola {{1}}, ¿pudiste resolver tu consulta sobre los trasteros?',
          paramCount: 1,
        },
      ];
    }
    const out: WhatsappTemplateDto[] = [];
    let url: string | null = `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(
      wabaId,
    )}/message_templates?fields=name,language,status,category,components&limit=100`;
    for (let page = 0; url && page < 5; page += 1) {
      const json = await this.request(url, accessToken, { method: 'GET' });
      const data = Array.isArray(json.data) ? (json.data as Record<string, unknown>[]) : [];
      for (const t of data) {
        if (t.status !== 'APPROVED' || typeof t.name !== 'string') continue;
        const components = Array.isArray(t.components)
          ? (t.components as { type?: string; text?: string }[])
          : [];
        const body = components.find((c) => c.type === 'BODY')?.text ?? '';
        out.push({
          name: t.name,
          language: typeof t.language === 'string' ? t.language : 'es',
          category: typeof t.category === 'string' ? t.category : null,
          body,
          paramCount: templateParamCount(body),
        });
      }
      const next = (json.paging as { next?: string } | undefined)?.next;
      url =
        typeof next === 'string' && next.startsWith('https://graph.facebook.com/') ? next : null;
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Descarga un archivo recibido (foto, audio…). Meta da primero una URL
   * temporal (solo de sus dominios) que se pide con el mismo token.
   */
  async downloadMedia(
    mediaId: string,
    accessToken: string,
  ): Promise<{ bytes: Buffer; mime: string | null }> {
    if (this.stub) {
      if (mediaId.startsWith('invalid')) throw new WhatsappCloudError('Archivo no disponible', 404);
      return { bytes: STUB_JPEG, mime: 'image/jpeg' };
    }
    const info = await this.request(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(mediaId)}`,
      accessToken,
      { method: 'GET' },
    );
    const url = typeof info.url === 'string' ? info.url : null;
    const size = typeof info.file_size === 'number' ? info.file_size : null;
    if (!url) throw new WhatsappCloudError('Meta no devolvió la URL del archivo', 502);
    if (size !== null && size > WHATSAPP_MEDIA_MAX_BYTES) {
      throw new WhatsappCloudError('El archivo es demasiado grande', 413);
    }
    let host: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') throw new Error('protocolo');
      host = parsed.hostname;
    } catch {
      throw new WhatsappCloudError('URL de archivo no válida', 502);
    }
    // Solo dominios de Meta: el token no debe salir hacia otro sitio.
    if (!/(^|\.)(fbsbx\.com|facebook\.com|whatsapp\.net|fbcdn\.net)$/.test(host)) {
      throw new WhatsappCloudError('URL de archivo fuera de Meta', 502);
    }
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(30_000),
        redirect: 'manual',
      });
    } catch (err) {
      throw new WhatsappCloudError(
        `No se pudo descargar el archivo: ${err instanceof Error ? err.message : String(err)}`,
        0,
      );
    }
    if (!res.ok) throw new WhatsappCloudError(`WhatsApp respondió ${res.status}`, res.status);
    // Se lee por partes y se corta al pasar del máximo (sin cargarlo entero).
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    if (!reader) throw new WhatsappCloudError('Respuesta vacía', 502);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > WHATSAPP_MEDIA_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new WhatsappCloudError('El archivo es demasiado grande', 413);
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    return {
      bytes,
      mime: typeof info.mime_type === 'string' ? info.mime_type : res.headers.get('content-type'),
    };
  }

  /** Sube un archivo a Meta y lo envía (foto o documento). Devuelve el wamid. */
  async sendMedia(args: {
    phoneNumberId: string;
    accessToken: string;
    to: string;
    type: 'image' | 'document';
    bytes: Buffer;
    mime: string;
    filename: string;
    caption?: string | undefined;
  }): Promise<{ messageId: string }> {
    if (this.stub) {
      this.logger.log(`[whatsapp:stub] ${args.type} ${args.filename} → ${args.to}`);
      return {
        messageId: `wamid.stub-media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      };
    }
    const base = `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(
      args.phoneNumberId,
    )}`;
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', args.mime);
    form.append('file', new Blob([new Uint8Array(args.bytes)], { type: args.mime }), args.filename);
    let uploaded: Record<string, unknown>;
    try {
      const res = await fetch(`${base}/media`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${args.accessToken}` },
        body: form,
        signal: AbortSignal.timeout(60_000),
        redirect: 'manual',
      });
      uploaded = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const detail = (uploaded.error as { message?: string } | undefined)?.message;
        throw new WhatsappCloudError(detail ?? `WhatsApp respondió ${res.status}`, res.status);
      }
    } catch (err) {
      if (err instanceof WhatsappCloudError) throw err;
      throw new WhatsappCloudError(
        `No se pudo subir el archivo: ${err instanceof Error ? err.message : String(err)}`,
        0,
      );
    }
    const mediaId = typeof uploaded.id === 'string' ? uploaded.id : null;
    if (!mediaId) throw new WhatsappCloudError('Meta no devolvió el id del archivo', 502);
    const payload =
      args.type === 'image'
        ? { id: mediaId, ...(args.caption ? { caption: args.caption } : {}) }
        : {
            id: mediaId,
            filename: args.filename,
            ...(args.caption ? { caption: args.caption } : {}),
          };
    const json = await this.request(`${base}/messages`, args.accessToken, {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: args.to,
        type: args.type,
        [args.type]: payload,
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
