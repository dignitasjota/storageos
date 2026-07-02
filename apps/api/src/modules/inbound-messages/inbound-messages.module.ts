import { Module } from '@nestjs/common';

import { CustomerMessagesModule } from '../customer-messages/customer-messages.module';

import { EmailInboundController } from './email-inbound.controller';
import { InboundMessagesService } from './inbound-messages.service';
import { WhatsAppInboundController } from './whatsapp-inbound.controller';

/**
 * Mensajes entrantes del inquilino por WhatsApp (webhook de Meta) o email
 * (webhook del proveedor de routing). Resuelven el customer por el remitente y
 * los registran en el hilo de chat (`customer_messages`) via CustomerMessages.
 */
@Module({
  imports: [CustomerMessagesModule],
  controllers: [WhatsAppInboundController, EmailInboundController],
  providers: [InboundMessagesService],
})
export class InboundMessagesModule {}
