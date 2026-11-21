import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
import { AccessModule } from '../access/access.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { CessionsListController, UnitCessionsController } from './unit-cessions.controller';
import { UnitCessionsCron } from './unit-cessions.cron';
import { UnitCessionsService } from './unit-cessions.service';

/**
 * Trasteros cedidos (función `unit_cession`, la activa el super admin). Los
 * avisos de vencimiento solo corren donde corren los workers.
 */
@Module({
  imports: [AuthModule, AccessModule, NotificationsModule],
  controllers: [UnitCessionsController, CessionsListController],
  providers: [UnitCessionsService, ...(WORKERS_ENABLED_IN_API ? [UnitCessionsCron] : [])],
  exports: [UnitCessionsService],
})
export class UnitCessionsModule {}
