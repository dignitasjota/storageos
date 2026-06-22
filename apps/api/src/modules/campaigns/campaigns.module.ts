import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';

/**
 * Crecimiento/CRM: campañas segmentadas por email. Segmenta clientes/leads y
 * encola un envío por destinatario en el outbox de communications.
 * `CommunicationsModule` es global (provee `CommunicationsService`).
 */
@Module({
  imports: [AuthModule],
  controllers: [CampaignsController],
  providers: [CampaignsService],
  exports: [CampaignsService],
})
export class CampaignsModule {}
