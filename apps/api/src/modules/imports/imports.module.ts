import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CustomersModule } from '../customers/customers.module';

import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

@Module({
  imports: [AuthModule, CustomersModule],
  controllers: [ImportsController],
  providers: [ImportsService],
})
export class ImportsModule {}
