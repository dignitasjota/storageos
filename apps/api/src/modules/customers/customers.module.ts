import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ReferralsModule } from '../referrals/referrals.module';

import { CustomerDocumentsController } from './customer-documents.controller';
import { CustomerDocumentsService } from './customer-documents.service';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  imports: [AuthModule, ReferralsModule],
  controllers: [CustomersController, CustomerDocumentsController],
  providers: [CustomersService, CustomerDocumentsService],
  exports: [CustomersService],
})
export class CustomersModule {}
