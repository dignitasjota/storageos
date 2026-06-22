import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';

import { BankReconciliationController } from './bank-reconciliation.controller';
import { BankReconciliationService } from './bank-reconciliation.service';

/**
 * Conciliación bancaria (Norma 43). Parsea el extracto del banco y concilia los
 * abonos contra las facturas pendientes. `BillingModule` provee
 * `InvoicesService` para marcar las facturas pagadas.
 */
@Module({
  imports: [AuthModule, BillingModule],
  controllers: [BankReconciliationController],
  providers: [BankReconciliationService],
  exports: [BankReconciliationService],
})
export class BankReconciliationModule {}
