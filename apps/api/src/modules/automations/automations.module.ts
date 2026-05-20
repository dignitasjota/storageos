import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { AutomationsController } from './automations.controller';
import { AutomationsProcessor } from './automations.processor';
import { AutomationsService } from './automations.service';

@Module({
  imports: [AuthModule],
  controllers: [AutomationsController],
  providers: [AutomationsService, AutomationsProcessor],
  exports: [AutomationsService],
})
export class AutomationsModule {}
