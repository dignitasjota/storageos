import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';

import { PortalController } from './portal.controller';
import { PortalService } from './portal.service';

@Module({
  // PaymentsModule: self-service de metodos de pago + cobro desde el portal
  // (PaymentMethodsService + PaymentsService).
  imports: [AuthModule, JwtModule.register({}), PaymentsModule],
  controllers: [PortalController],
  providers: [PortalService],
})
export class PortalModule {}
