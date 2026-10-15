import { Module } from '@nestjs/common';

import { RedsysChargeService } from './redsys-charge.service';
import { RedsysSettingsService } from './redsys-settings.service';

/**
 * Núcleo de Redsys **sin dependencias de `PaymentsModule`**: config por tenant
 * y cobro con tarjeta guardada. Lo importan `PaymentsModule` (para que
 * `chargeInvoice` cobre por Redsys) y `RedsysModule`, evitando el ciclo.
 */
@Module({
  providers: [RedsysSettingsService, RedsysChargeService],
  exports: [RedsysSettingsService, RedsysChargeService],
})
export class RedsysCoreModule {}
