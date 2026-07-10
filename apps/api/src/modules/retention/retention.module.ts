import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';

import { RetentionDiscountExpiryCron } from './retention-discount-expiry.cron';
import { RetentionController } from './retention.controller';
import { RetentionService } from './retention.service';

@Module({
  imports: [AuthModule, EmailModule],
  controllers: [RetentionController],
  providers: [RetentionService, ...(WORKERS_ENABLED_IN_API ? [RetentionDiscountExpiryCron] : [])],
  exports: [RetentionService],
})
export class RetentionModule {}
