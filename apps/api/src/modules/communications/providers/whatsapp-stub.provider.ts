import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  WHATSAPP_NOT_CONFIGURED,
  WhatsAppProvider,
  type SendWhatsAppArgs,
  type SendWhatsAppResult,
} from './whatsapp-provider';

import type { Env } from '../../../config/env.schema';

/**
 * Simulador (`WHATSAPP_PROVIDER=stub`). En desarrollo y tests «envía»: loguea y
 * devuelve un id falso para que el flujo se pueda probar. En producción NO
 * finge: el mensaje queda omitido con el motivo (antes quedaba «enviado» sin
 * que saliera nada).
 */
@Injectable()
export class WhatsAppStubProvider extends WhatsAppProvider {
  private readonly logger = new Logger(WhatsAppStubProvider.name);
  private readonly simulate: boolean;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.simulate = config.get('NODE_ENV', { infer: true }) !== 'production';
  }

  get name(): string {
    return 'whatsapp_stub';
  }

  get available(): boolean {
    return this.simulate;
  }

  async send(args: SendWhatsAppArgs): Promise<SendWhatsAppResult> {
    if (!this.simulate) {
      this.logger.warn(`[whatsapp_stub] WhatsApp sin configurar, no se envía a ${args.to}`);
      return { providerMessageId: null, skipped: WHATSAPP_NOT_CONFIGURED };
    }
    this.logger.warn(`[whatsapp_stub] simulando envio a ${args.to}: ${args.body.slice(0, 80)}...`);
    return { providerMessageId: `stub-${randomUUID()}` };
  }
}
