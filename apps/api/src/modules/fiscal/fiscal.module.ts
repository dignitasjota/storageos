import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { FiscalController } from './fiscal.controller';
import { FiscalService } from './fiscal.service';

/**
 * Informes fiscales (España): libro registro de IVA emitido, modelo 303 (IVA
 * devengado) y modelo 347. Solo lectura, derivados de las facturas emitidas.
 */
@Module({
  imports: [AuthModule],
  controllers: [FiscalController],
  providers: [FiscalService],
  exports: [FiscalService],
})
export class FiscalModule {}
