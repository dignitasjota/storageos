import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ContractsModule } from '../contracts/contracts.module';
import { CustomersModule } from '../customers/customers.module';
import { ExpensesModule } from '../expenses/expenses.module';
import { FacilitiesModule } from '../facilities/facilities.module';
import { SepaModule } from '../sepa/sepa.module';

import { ContractsImportService } from './contracts-import.service';
import { ExpensesImportService } from './expenses-import.service';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';
import { SepaMandatesImportService } from './sepa-mandates-import.service';
import { UnitsImportService } from './units-import.service';

@Module({
  imports: [
    AuthModule,
    CustomersModule,
    FacilitiesModule,
    ContractsModule,
    SepaModule,
    ExpensesModule,
  ],
  controllers: [ImportsController],
  providers: [
    ImportsService,
    UnitsImportService,
    ContractsImportService,
    SepaMandatesImportService,
    ExpensesImportService,
  ],
})
export class ImportsModule {}
