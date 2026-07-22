import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';
import { WinbackCron } from './winback.cron';
import { WinbackService } from './winback.service';

/**
 * Crecimiento/CRM: campañas segmentadas por email + win-back automático de bajas.
 * Segmenta clientes/leads y encola un envío por destinatario en el outbox de
 * communications. `CommunicationsModule` es global (provee `CommunicationsService`).
 * El cron de win-back corre en el API sin gatear (ligero; encola emails y se
 * deduplica con `winback_sends` + `claimDailyCronRun`), como los demás digests.
 */
@Module({
  imports: [AuthModule],
  controllers: [CampaignsController],
  providers: [CampaignsService, WinbackService, WinbackCron],
  exports: [CampaignsService, WinbackService],
})
export class CampaignsModule {}
