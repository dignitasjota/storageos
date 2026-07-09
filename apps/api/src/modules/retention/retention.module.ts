import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';

import { RetentionController } from './retention.controller';
import { RetentionService } from './retention.service';

@Module({
  imports: [AuthModule, EmailModule],
  controllers: [RetentionController],
  providers: [RetentionService],
  exports: [RetentionService],
})
export class RetentionModule {}
