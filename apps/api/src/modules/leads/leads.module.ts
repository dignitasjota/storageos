import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CouponsModule } from '../coupons/coupons.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { LeadCrmController } from './lead-crm.controller';
import { LeadCrmService } from './lead-crm.service';
import { LeadQuotesService } from './lead-quotes.service';
import { LeadUnattendedCron } from './lead-unattended.cron';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

@Module({
  imports: [AuthModule, CouponsModule, NotificationsModule],
  controllers: [LeadCrmController, LeadsController],
  providers: [LeadsService, LeadQuotesService, LeadCrmService, LeadUnattendedCron],
  exports: [LeadsService, LeadCrmService],
})
export class LeadsModule {}
