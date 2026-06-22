import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { InsuranceController } from './insurance.controller';
import { InsuranceService } from './insurance.service';

/**
 * Revenue: planes de seguro / protección de contenido. La asignación a un
 * contrato y la línea recurrente en factura viven en ContractsModule /
 * BillingModule (reusan el snapshot `contracts.insurance_price`).
 */
@Module({
  imports: [AuthModule],
  controllers: [InsuranceController],
  providers: [InsuranceService],
  exports: [InsuranceService],
})
export class InsuranceModule {}
