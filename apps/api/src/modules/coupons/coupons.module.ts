import { Module } from '@nestjs/common';

import { CouponsController } from './coupons.controller';
import { CouponsService } from './coupons.service';

/**
 * Cupones: descuento sobre el pago que se hace en ese momento (de 1 a 12
 * meses por adelantado), no sobre las renovaciones.
 */
@Module({
  controllers: [CouponsController],
  providers: [CouponsService],
  exports: [CouponsService],
})
export class CouponsModule {}
