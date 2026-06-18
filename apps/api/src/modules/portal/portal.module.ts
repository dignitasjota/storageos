import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AccessModule } from '../access/access.module';
import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';
import { RedsysModule } from '../payments/redsys/redsys.module';

import { PortalController } from './portal.controller';
import { PortalService } from './portal.service';

@Module({
  // PaymentsModule: self-service de metodos de pago + cobro desde el portal.
  // RedsysModule: pago de facturas por TPV bancario (redirect) desde el portal.
  // AccessModule: el inquilino ve/regenera su credencial QR/PIN.
  imports: [AuthModule, JwtModule.register({}), PaymentsModule, RedsysModule, AccessModule],
  controllers: [PortalController],
  providers: [PortalService],
})
export class PortalModule {}
