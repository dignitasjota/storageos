import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CommunicationsModule } from '../communications/communications.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { CustomerOffersService } from './customer-offers.service';
import { OpportunitiesController } from './opportunities.controller';
import { OpportunitiesService } from './opportunities.service';

@Module({
  imports: [AuthModule, CommunicationsModule, NotificationsModule],
  controllers: [OpportunitiesController],
  providers: [OpportunitiesService, CustomerOffersService],
  exports: [OpportunitiesService, CustomerOffersService],
})
export class OpportunitiesModule {}
