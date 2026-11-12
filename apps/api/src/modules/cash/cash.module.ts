import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { CashClosurePdfService } from './cash-closure-pdf.service';
import { CashController } from './cash.controller';
import { CashService } from './cash.service';

/** Cierre de caja diario (arqueo de efectivo). AuthModule aporta AuditService. */
@Module({
  imports: [AuthModule],
  controllers: [CashController],
  providers: [CashService, CashClosurePdfService],
  exports: [CashService],
})
export class CashModule {}
