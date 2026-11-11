import { Module } from '@nestjs/common';

import { SepaMandatePdfService } from '../../common/sepa-mandate/sepa-mandate-pdf.service';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { CommunicationsModule } from '../communications/communications.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { SepaAutomationService } from './sepa-automation.service';
import { SepaMandateExpiryCron } from './sepa-mandate-expiry.cron';
import { SepaMandatePublicController } from './sepa-mandate-public.controller';
import { SepaController } from './sepa.controller';
import { SepaService } from './sepa.service';

/**
 * Pagos España: remesas SEPA (adeudos directos). Genera el fichero pain.008
 * que el operador sube a su banco. `BillingModule` provee `InvoicesService`
 * para marcar las facturas pagadas al confirmar la remesa. `CryptoService`
 * (CryptoModule global) cifra los IBAN.
 */
@Module({
  imports: [AuthModule, BillingModule, CommunicationsModule, NotificationsModule],
  controllers: [SepaController, SepaMandatePublicController],
  // La remesa automática y los avisos corren en el API, una vez al día entre
  // réplicas (`claimDailyCronRun`), como la caducidad de los mandatos.
  providers: [SepaService, SepaMandatePdfService, SepaMandateExpiryCron, SepaAutomationService],
  exports: [SepaService],
})
export class SepaModule {}
