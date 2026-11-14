import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
import { AuthModule } from '../auth/auth.module';
import { CustomerEmailsModule } from '../customer-emails/customer-emails.module';

import { RentIncreaseApplyCron } from './rent-increase-apply.cron';
import { RentIncreasesController } from './rent-increases.controller';
import { RentIncreasesService } from './rent-increases.service';

/**
 * Subidas de precio a la cartera: programa una tanda con su preaviso por
 * correo y la aplica en su fecha (proceso diario, solo donde corren workers).
 */
@Module({
  imports: [AuthModule, CustomerEmailsModule],
  controllers: [RentIncreasesController],
  providers: [RentIncreasesService, ...(WORKERS_ENABLED_IN_API ? [RentIncreaseApplyCron] : [])],
  exports: [RentIncreasesService],
})
export class RentIncreasesModule {}
