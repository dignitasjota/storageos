import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Job, Queue } from 'bullmq';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { JOB_BILLING_GENERATE_RECURRING, QUEUE_BILLING } from '../queues/queues.module';

import { InvoiceSeriesService } from './invoice-series.service';
import { InvoicesService } from './invoices.service';
import { PricingRulesService } from './pricing-rules.service';

interface GenerateRecurringJobData {
  tenantId: string;
  /** Periodo a facturar. Default: mes natural anterior al `runAt`. */
  periodStart?: string;
  periodEnd?: string;
}

/**
 * Cron diario que encola un job `generate-recurring` por cada tenant
 * activo. El worker procesa: para cada contrato activo cuyo periodo
 * facturable corresponda al mes en curso y NO tenga ya una invoice
 * emitida para ese periodo, genera una nueva en estado `draft` con una
 * linea por contrato y los importes resueltos por PricingRulesService.
 *
 * Decision: en MVP la emision NO es automatica (queda en draft para
 * que el admin revise antes de emitir). Esto evita errores caros con
 * Verifactu (hash inmutable tras issue). En Fase 8+ se anyade un flag
 * `auto_issue` por tenant para automatizar.
 */
@Injectable()
@Processor(QUEUE_BILLING)
export class BillingJobsService extends WorkerHost {
  private readonly logger = new Logger(BillingJobsService.name);

  constructor(
    @InjectQueue(QUEUE_BILLING) private readonly queue: Queue,
    private readonly admin: PrismaAdminService,
    private readonly invoices: InvoicesService,
    private readonly series: InvoiceSeriesService,
    private readonly pricing: PricingRulesService,
  ) {
    super();
  }

  /**
   * Cron diario a las 02:00 UTC. Encola un job por tenant activo. En
   * dev se puede disparar manualmente con `POST /billing/jobs/run-recurring`.
   */
  @Cron('0 2 * * *', { name: 'billing.generate-recurring.daily' })
  async dailyEnqueue(): Promise<void> {
    const tenants = await this.admin.tenant.findMany({
      where: {
        deletedAt: null,
        status: { in: ['trial', 'active'] },
      },
      select: { id: true, slug: true },
    });
    for (const t of tenants) {
      await this.queue.add(JOB_BILLING_GENERATE_RECURRING, {
        tenantId: t.id,
      } satisfies GenerateRecurringJobData);
    }
    this.logger.log(`Encolados ${tenants.length} jobs de facturacion recurrente`);
  }

  /** Punto manual de disparo (endpoint admin). */
  async enqueueForTenant(tenantId: string): Promise<{ jobId: string }> {
    const job = await this.queue.add(JOB_BILLING_GENERATE_RECURRING, {
      tenantId,
    } satisfies GenerateRecurringJobData);
    return { jobId: String(job.id ?? '') };
  }

  /** Handler del worker. */
  async process(job: Job<GenerateRecurringJobData>): Promise<{ created: number }> {
    if (job.name !== JOB_BILLING_GENERATE_RECURRING) {
      return { created: 0 };
    }
    const { tenantId } = job.data;
    const { periodStart, periodEnd } = this.resolvePeriod(job.data);

    // Contratos activos que NO tengan invoice issued/paid para este periodo.
    const contracts = await this.admin.contract.findMany({
      where: {
        tenantId,
        status: { in: ['active', 'ending'] },
        deletedAt: null,
      },
      include: {
        unit: { select: { id: true, facilityId: true, unitTypeId: true } },
      },
    });

    let created = 0;
    for (const c of contracts) {
      const already = await this.admin.invoice.findFirst({
        where: {
          tenantId,
          contractId: c.id,
          periodStart,
          periodEnd,
          status: { not: 'cancelled' },
          deletedAt: null,
        },
        select: { id: true },
      });
      if (already) continue;

      const pricing = await this.pricing.resolve({
        tenantId,
        basePrice: Number(c.priceMonthly) - Number(c.discountAmount),
        unitId: c.unit.id,
        unitTypeId: c.unit.unitTypeId,
        facilityId: c.unit.facilityId,
        at: periodStart,
      });

      const series = await this.series.getDefault(tenantId);
      if (!series) {
        this.logger.warn(`Tenant ${tenantId} sin serie por defecto; salto contrato ${c.id}`);
        continue;
      }

      await this.invoices.create({
        tenantId,
        userId: c.customerId, // marcador: lo lanzo el sistema; en audit se filtrara
        input: {
          customerId: c.customerId,
          contractId: c.id,
          seriesId: series.id,
          periodStart: periodStart.toISOString().slice(0, 10),
          periodEnd: periodEnd.toISOString().slice(0, 10),
          dueDate: this.addDays(periodEnd, 15).toISOString().slice(0, 10),
          items: [
            {
              description: `Alquiler ${c.contractNumber} (${periodStart
                .toISOString()
                .slice(0, 7)})`,
              quantity: 1,
              unitPrice: pricing.effectivePrice,
              taxRate: 21,
              relatedContractId: c.id,
              relatedUnitId: c.unit.id,
              periodStart: periodStart.toISOString().slice(0, 10),
              periodEnd: periodEnd.toISOString().slice(0, 10),
            },
          ],
          verifactuMode: 'verifactu',
        },
        meta: {},
      });
      created += 1;
    }
    this.logger.log(`Tenant ${tenantId}: ${created} facturas borrador creadas para el periodo`);
    return { created };
  }

  private resolvePeriod(data: GenerateRecurringJobData): {
    periodStart: Date;
    periodEnd: Date;
  } {
    if (data.periodStart && data.periodEnd) {
      return {
        periodStart: new Date(data.periodStart),
        periodEnd: new Date(data.periodEnd),
      };
    }
    // Default: mes en curso del momento de ejecucion.
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
    return { periodStart: start, periodEnd: end };
  }

  private addDays(d: Date, days: number): Date {
    const copy = new Date(d);
    copy.setUTCDate(copy.getUTCDate() + days);
    return copy;
  }
}
