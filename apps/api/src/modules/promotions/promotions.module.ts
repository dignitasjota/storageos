import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { PromotionsController } from './promotions.controller';
import { PromotionsService } from './promotions.service';

/**
 * Crecimiento/CRM: códigos promocionales. CRUD + validación + aplicación en el
 * alta de contrato (descuento recurrente sobre la cuota). La tabla `promotions`
 * ya existía; este módulo expone su gestión.
 */
@Module({
  imports: [AuthModule],
  controllers: [PromotionsController],
  providers: [PromotionsService],
  exports: [PromotionsService],
})
export class PromotionsModule {}
