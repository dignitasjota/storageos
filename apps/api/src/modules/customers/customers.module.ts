import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ReferralsModule } from '../referrals/referrals.module';

import { CustomerDocumentsController } from './customer-documents.controller';
import { CustomerDocumentsService } from './customer-documents.service';
import { CustomerInteractionsController } from './customer-interactions.controller';
import { CustomerInteractionsService } from './customer-interactions.service';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  imports: [AuthModule, ReferralsModule],
  controllers: [CustomersController, CustomerDocumentsController, CustomerInteractionsController],
  providers: [CustomersService, CustomerDocumentsService, CustomerInteractionsService],
  exports: [CustomersService, CustomerDocumentsService],
})
export class CustomersModule {}
