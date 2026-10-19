import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CouponsModule } from '../coupons/coupons.module';

import { LeadQuotesService } from './lead-quotes.service';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

@Module({
  imports: [AuthModule, CouponsModule],
  controllers: [LeadsController],
  providers: [LeadsService, LeadQuotesService],
  exports: [LeadsService],
})
export class LeadsModule {}
