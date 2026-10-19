import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CommunicationsModule } from '../communications/communications.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { CollectionsOpsController } from './collections-ops.controller';
import { CollectionsOpsService } from './collections-ops.service';
import { PaymentPlansService } from './payment-plans.service';

@Module({
  imports: [AuthModule, CommunicationsModule, NotificationsModule],
  controllers: [CollectionsOpsController],
  providers: [CollectionsOpsService, PaymentPlansService],
  exports: [PaymentPlansService],
})
export class CollectionsOpsModule {}
