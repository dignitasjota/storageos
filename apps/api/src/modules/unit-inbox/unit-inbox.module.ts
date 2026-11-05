import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { UnitInboxController } from './unit-inbox.controller';
import { UnitInboxService } from './unit-inbox.service';

@Module({
  imports: [AuthModule],
  controllers: [UnitInboxController],
  providers: [UnitInboxService],
})
export class UnitInboxModule {}
