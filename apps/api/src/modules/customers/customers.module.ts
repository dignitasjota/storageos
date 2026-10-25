import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ReferralsModule } from '../referrals/referrals.module';

import { CustomerAuthorizedPersonsController } from './customer-authorized-persons.controller';
import { CustomerAuthorizedPersonsService } from './customer-authorized-persons.service';
import { CustomerDocumentsController } from './customer-documents.controller';
import { CustomerDocumentsService } from './customer-documents.service';
import { CustomerExtrasController } from './customer-extras.controller';
import { CustomerExtrasService } from './customer-extras.service';
import { CustomerInteractionsController } from './customer-interactions.controller';
import { CustomerInteractionsService } from './customer-interactions.service';
import { CustomerOverviewController } from './customer-overview.controller';
import { CustomerOverviewService } from './customer-overview.service';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  imports: [AuthModule, ReferralsModule],
  controllers: [
    CustomerOverviewController,
    CustomerExtrasController,
    CustomersController,
    CustomerDocumentsController,
    CustomerInteractionsController,
    CustomerAuthorizedPersonsController,
  ],
  providers: [
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
