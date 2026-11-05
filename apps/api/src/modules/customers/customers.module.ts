import { Module } from '@nestjs/common';

import { AnalyticsModule } from '../analytics/analytics.module';
import { AuthModule } from '../auth/auth.module';
import { CommunicationsModule } from '../communications/communications.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ReferralsModule } from '../referrals/referrals.module';

import { CustomerAuthorizedPersonsController } from './customer-authorized-persons.controller';
import { CustomerAuthorizedPersonsService } from './customer-authorized-persons.service';
import { CustomerDocumentsController } from './customer-documents.controller';
import { CustomerDocumentsService } from './customer-documents.service';
import { CustomerExtrasController } from './customer-extras.controller';
import { CustomerExtrasService } from './customer-extras.service';
import { CustomerFeaturesController } from './customer-features.controller';
import { CustomerInsightsService } from './customer-insights.service';
import { CustomerInteractionsController } from './customer-interactions.controller';
import { CustomerInteractionsService } from './customer-interactions.service';
import { CustomerMergeService } from './customer-merge.service';
import { CustomerOverviewController } from './customer-overview.controller';
import { CustomerOverviewService } from './customer-overview.service';
import { CustomerTimelineService } from './customer-timeline.service';
import { CustomerToolsService } from './customer-tools.service';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  imports: [
    AuthModule,
    ReferralsModule,
    CommunicationsModule,
    AnalyticsModule,
    NotificationsModule,
  ],
  controllers: [
    CustomerOverviewController,
    CustomerFeaturesController,
    CustomerExtrasController,
    CustomersController,
    CustomerDocumentsController,
    CustomerInteractionsController,
    CustomerAuthorizedPersonsController,
  ],
  providers: [
    CustomerMergeService,
    CustomerTimelineService,
    CustomerInsightsService,
    CustomerToolsService,
    CustomerOverviewService,
    CustomerExtrasService,
    CustomersService,
    CustomerDocumentsService,
    CustomerInteractionsService,
    CustomerAuthorizedPersonsService,
  ],
  exports: [CustomersService],
})
export class CustomersModule {}
