import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { ReferralsController } from './referrals.controller';
import { ReferralsService } from './referrals.service';

/**
 * Crecimiento/CRM: programa de referidos. Registro en el alta (best-effort),
 * conversión + recompensa al firmar el primer contrato del referido (listener
 * `contract_signed`), panel de staff y vista del portal del inquilino.
 */
@Module({
  imports: [AuthModule],
  controllers: [ReferralsController],
  providers: [ReferralsService],
  exports: [ReferralsService],
})
export class ReferralsModule {}
