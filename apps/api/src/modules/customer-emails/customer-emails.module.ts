import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CommunicationsModule } from '../communications/communications.module';

import { CustomerEmailsController } from './customer-emails.controller';
import { CustomerEmailsService } from './customer-emails.service';

/**
 * Correos automáticos del tenant a sus inquilinos. Registrado en el API y en
 * el worker: los eventos que los disparan se emiten en ambos procesos
 * (facturación recurrente, dunning y crons corren en el worker).
 */
@Module({
  imports: [AuthModule, CommunicationsModule],
  controllers: [CustomerEmailsController],
  providers: [CustomerEmailsService],
})
export class CustomerEmailsModule {}
