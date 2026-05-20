import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import {
  WhatsAppProvider,
  type SendWhatsAppArgs,
  type SendWhatsAppResult,
} from './whatsapp-provider';

/**
 * Stub local: loggea pero no envia nada externo. Genera un id pseudo-WAMID
 * para que la communication pueda quedar marcada como `sent`. En Fase 8
 * lo sustituiremos por `MetaWabaProvider` (clases abstractas iguales).
 */
@Injectable()
export class WhatsAppStubProvider extends WhatsAppProvider {
  private readonly logger = new Logger(WhatsAppStubProvider.name);

  get name(): string {
    return 'whatsapp_stub';
  }

  async send(args: SendWhatsAppArgs): Promise<SendWhatsAppResult> {
    this.logger.warn(`[whatsapp_stub] simulando envio a ${args.to}: ${args.body.slice(0, 80)}...`);
    return { providerMessageId: `stub-${randomUUID()}` };
  }
}
