import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CommunicationsModule } from '../communications/communications.module';
import { QUEUE_EMAIL } from '../queues/queue-names';

import { CustomerEmailsController, StaffEmailsController } from './customer-emails.controller';
import { CustomerEmailsService } from './customer-emails.service';
import { StaffEmailsService } from './staff-emails.service';

/**
 * Correos automáticos del tenant a sus inquilinos y avisos por email a su equipo. Registrado en el API y en
 * el worker: los eventos que los disparan se emiten en ambos procesos
 * (facturación recurrente, dunning y crons corren en el worker).
 */
@Module({
  imports: [AuthModule, CommunicationsModule, BullModule.registerQueue({ name: QUEUE_EMAIL })],
  controllers: [CustomerEmailsController, StaffEmailsController],
  providers: [CustomerEmailsService, StaffEmailsService],
})
export class CustomerEmailsModule {}
