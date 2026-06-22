import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';

import { SepaController } from './sepa.controller';
import { SepaService } from './sepa.service';

/**
 * Pagos España: remesas SEPA (adeudos directos). Genera el fichero pain.008
 * que el operador sube a su banco. `BillingModule` provee `InvoicesService`
 * para marcar las facturas pagadas al confirmar la remesa. `CryptoService`
 * (CryptoModule global) cifra los IBAN.
 */
@Module({
  imports: [AuthModule, BillingModule],
  controllers: [SepaController],
  providers: [SepaService],
  exports: [SepaService],
})
export class SepaModule {}
