import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
import { AuthModule } from '../auth/auth.module';

import { RentIncreaseApplyCron } from './rent-increase-apply.cron';
import { RentIncreasesController } from './rent-increases.controller';
import { RentIncreasesService } from './rent-increases.service';

/**
 * Revenue (ECRI): subidas de precio a clientes en cartera. Programa una tanda
 * con preaviso por email y la aplica en la fecha efectiva (cron, solo donde
 * corren workers). `CommunicationsModule` es global.
 */
@Module({
  imports: [AuthModule],
  controllers: [RentIncreasesController],
  providers: [RentIncreasesService, ...(WORKERS_ENABLED_IN_API ? [RentIncreaseApplyCron] : [])],
  exports: [RentIncreasesService],
})
export class RentIncreasesModule {}
