import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CouponsModule } from '../coupons/coupons.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { LeadAutomationsCron } from './lead-automations.cron';
import { LeadCrmController } from './lead-crm.controller';
import { LeadCrmService } from './lead-crm.service';
import { LeadInsightsService } from './lead-insights.service';
import { LeadNurtureService } from './lead-nurture.service';
import { LeadQuotesService } from './lead-quotes.service';
import { LeadRetentionCron } from './lead-retention.cron';
import { LeadToolsController } from './lead-tools.controller';
import { LeadUnattendedCron } from './lead-unattended.cron';
import { LeadVisitsService } from './lead-visits.service';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

@Module({
  imports: [AuthModule, CouponsModule, NotificationsModule],
  controllers: [LeadCrmController, LeadToolsController, LeadsController],
  providers: [
    LeadsService,
    LeadQuotesService,
    LeadCrmService,
    LeadInsightsService,
    LeadNurtureService,
    LeadVisitsService,
    LeadUnattendedCron,
    LeadRetentionCron,
    LeadAutomationsCron,
  ],
  exports: [LeadsService, LeadCrmService],
})
export class LeadsModule {}
