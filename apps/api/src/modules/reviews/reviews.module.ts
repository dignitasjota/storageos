import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
import { AuthModule } from '../auth/auth.module';

import { ReviewRequestCron } from './review-request.cron';
import { ReviewsPublicController } from './reviews-public.controller';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';

/**
 * Crecimiento/CRM: valoraciones (NPS) del inquilino.
 * - Staff: solicitar valoración + lista + stats.
 * - Público: contexto + envío por token.
 * - Cron de auto-solicitud (opt-in por tenant), solo donde corren workers.
 */
@Module({
  imports: [AuthModule],
  controllers: [ReviewsController, ReviewsPublicController],
  providers: [ReviewsService, ...(WORKERS_ENABLED_IN_API ? [ReviewRequestCron] : [])],
  exports: [ReviewsService],
})
export class ReviewsModule {}
