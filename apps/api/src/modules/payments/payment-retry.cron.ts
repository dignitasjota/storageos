import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { PaymentRetryService } from './payment-retry.service';

/**
 * Reintenta a diario el cobro automático de las facturas vencidas (con backoff
 * por tenant). `claimDailyCronRun` (mismo patrón que winback/rent-increases)
 * asegura que solo una réplica del worker lo ejecute cada día — si el worker
 * escalara a varias réplicas, dos ejecuciones a la vez procesarían las mismas
 * facturas en paralelo (el cobro en sí ya está protegido por el candado de
 * factura-en-curso, pero esto evita el trabajo duplicado desde la raíz).
 * Solo se registra cuando `ENABLE_WORKERS_IN_API=true` (corre en el worker en
 * producción).
 */
@Injectable()
export class PaymentRetryCron {
  private readonly logger = new Logger(PaymentRetryCron.name);

  constructor(
    private readonly retries: PaymentRetryService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('0 9 * * *', { name: 'payments.auto-retry' })
  async run(): Promise<{ attempted: number; recovered: number }> {
    if (!(await claimDailyCronRun(this.admin, 'payments.auto-retry'))) {
      return { attempted: 0, recovered: 0 };
    }
    const result = await this.retries.runRetries();
    if (result.attempted > 0) {
      this.logger.log(
        `[payment-retry] ${result.attempted} reintentos, ${result.recovered} recuperados`,
      );
    }
    return result;
  }
}
