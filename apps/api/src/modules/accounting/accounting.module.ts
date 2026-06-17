import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { HoldedSettingsService } from './holded-settings.service';
import { HoldedSyncService } from './holded-sync.service';
import { HoldedController } from './holded.controller';

/**
 * Integración contable. De momento Holded (export de facturas + contactos).
 * `HoldedSyncService` escucha `domain.invoice_issued` y empuja la factura
 * best-effort; el sync manual y el backfill cubren los fallos.
 */
@Module({
  imports: [AuthModule],
  controllers: [HoldedController],
  providers: [HoldedSettingsService, HoldedSyncService],
})
export class AccountingModule {}
