import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { ReferralsController } from './referrals.controller';
import { ReferralsService } from './referrals.service';

/**
 * Crecimiento/CRM: programa de referidos. Registro en el alta (best-effort),
 * conversión + recompensa cuando el recomendado paga su primera factura
 * (listener `invoice_paid`), panel de staff y vista del portal del inquilino.
 */
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [ReferralsController],
  providers: [ReferralsService],
  exports: [ReferralsService],
})
export class ReferralsModule {}
