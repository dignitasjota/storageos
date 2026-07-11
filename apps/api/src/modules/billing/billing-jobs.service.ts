import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

import { toCents } from '../../common/money';
import { isUniqueViolation } from '../../common/prisma-errors';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { JOB_BILLING_GENERATE_RECURRING, QUEUE_BILLING } from '../queues/queues.module';

import { InvoiceSeriesService } from './invoice-series.service';
import { InvoicesService } from './invoices.service';
import { PricingRulesService } from './pricing-rules.service';

export interface GenerateRecurringJobData {
  tenantId: string;
  /** Periodo a facturar. Default: mes natural anterior al `runAt`. */
  periodStart?: string;
  periodEnd?: string;
}

/**
 * Logica de facturacion recurrente: encolado + procesamiento de jobs
 * `generate-recurring`. Antes (Fase 4) esta clase tenia los decoradores
 * `@Processor` y `@Cron` integrados. En Sub-bloque 14A.1 se separan a
 * `BillingRecurringProcessor` y `BillingRecurringCron` para poder
 * registrar SOLO el procesador/cron cuando `ENABLE_WORKERS_IN_API=true`
 * (dev/test/worker) y mantener este service registrado SIEMPRE en el
 * API (el `InvoicesController.runRecurring` lo necesita para encolar
 * jobs manuales con `enqueueForTenant`).
 *
 * Decision: en MVP la emision NO es automatica (queda en draft para
 * que el admin revise antes de emitir). Esto evita errores caros con
 * Verifactu (hash inmutable tras issue). En Fase 8+ se anyade un flag
 * `auto_issue` por tenant para automatizar.
 */
@Injectable()
export class BillingJobsService {
  private readonly logger = new Logger(BillingJobsService.name);

  constructor(
    @InjectQueue(QUEUE_BILLING) private readonly queue: Queue,
    private readonly admin: PrismaAdminService,
    private readonly invoices: InvoicesService,
    private readonly series: InvoiceSeriesService,
    private readonly pricing: PricingRulesService,
  ) {}

  /**
   * Encola un job `generate-recurring` por cada tenant activo. Lo llama
   * el cron diario 02:00 UTC (`BillingRecurringCron`).
   */
  async dailyEnqueueAll(): Promise<void> {
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

  /**
   * Procesa un job `generate-recurring`: para cada contrato activo del
   * tenant cuyo periodo facturable corresponda al mes en curso y NO
   * tenga ya una invoice emitida para ese periodo, genera una nueva en
   * estado `draft` con una linea por contrato y los importes resueltos
   * por `PricingRulesService`. Llamado desde `BillingRecurringProcessor`.
   */
  async processGenerateRecurring(data: GenerateRecurringJobData): Promise<{ created: number }> {
    const { tenantId } = data;
    const { periodStart, periodEnd } = this.resolvePeriod(data);

    // Emisión automática (opt-in): si el tenant lo activó, cada factura recurrente
    // se emite tras crearse en vez de quedar en borrador para revisión manual.
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { autoIssueRecurring: true },
    });
    const autoIssue = tenant?.autoIssueRecurring ?? false;

    // Contratos activos que NO tengan invoice issued/paid para este periodo.
    const contracts = await this.admin.contract.findMany({
      where: {
        tenantId,
        status: { in: ['active', 'ending'] },
        deletedAt: null,
      },
      include: {
        unit: { select: { id: true, facilityId: true, unitTypeId: true } },
        insurancePlan: { select: { name: true, taxRate: true } },
      },
    });

    let created = 0;
    for (const c of contracts) {
      const interval = c.billingIntervalMonths;
      // Periodo a facturar de ESTE contrato:
      // - mensual (interval=1): el periodo global del run (mes natural en curso).
      // - prepago (interval>1): el SIGUIENTE periodo no cubierto = [fin de la
      //   última factura +1, +N meses−1 día]. Solo se emite cuando ese periodo ya
      //   ha empezado (anchor <= fin del mes en curso); mientras la cobertura del
      //   prepago sigue vigente, el contrato se salta (no se factura de más).
      let cStart = periodStart;
      let cEnd = periodEnd;
      if (interval > 1) {
        const last = await this.admin.invoice.findFirst({
          where: { tenantId, contractId: c.id, status: { not: 'cancelled' }, deletedAt: null },
          orderBy: { periodEnd: 'desc' },
          select: { periodEnd: true },
        });
        cStart = last?.periodEnd
          ? this.addDays(new Date(last.periodEnd), 1)
          : new Date(c.startDate);
        if (cStart > periodEnd) continue; // cobertura aún vigente / periodo futuro
        cEnd = this.addDays(this.addMonths(cStart, interval), -1);
      }

      // Dedup por SOLAPAMIENTO de periodo (no coincidencia exacta): la 1ª factura
      // del move-in cubre [alta, fin de mes natural], que rara vez casa día a día
      // con [día 1, último día] de la recurrente. Con coincidencia exacta el
      // primer mes se facturaba dos veces (solape sin dedup). `[a,b]` solapa con
      // `[start,end]` sii `a <= end && b >= start`.
      const already = await this.admin.invoice.findFirst({
        where: {
          tenantId,
          contractId: c.id,
          periodStart: { lte: cEnd },
          periodEnd: { gte: cStart },
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
        at: cStart,
      });

      const series = await this.series.getDefault(tenantId);
      if (!series) {
        this.logger.warn(`Tenant ${tenantId} sin serie por defecto; salto contrato ${c.id}`);
        continue;
      }

      // Promoción `free_months`: las primeras N facturas salen con el alquiler
      // a 0 (el seguro/extras se siguen cobrando). Se decrementa al final.
      // (No aplica a prepago: los meses gratis son un concepto mensual.)
      const isFreeMonth = interval === 1 && c.freeMonthsRemaining > 0;
      const rentMonth = cStart.toISOString().slice(0, 7);
      // Alquiler del periodo: prepago = cuota × N meses × (1 − descuento prepago).
      const prepayPct = interval > 1 ? Number(c.prepayDiscountPct) : 0;
      const rentUnitPrice = isFreeMonth
        ? 0
        : Math.round(toCents(pricing.effectivePrice) * interval * (1 - prepayPct / 100)) / 100;
      const rentDesc =
        interval > 1
          ? `Alquiler ${c.contractNumber} (${cStart.toISOString().slice(0, 10)}–${cEnd
              .toISOString()
              .slice(0, 10)}, ${interval} meses prepago${prepayPct > 0 ? ` −${prepayPct}%` : ''})`
          : `Alquiler ${c.contractNumber} (${rentMonth})${
              isFreeMonth ? ' — mes gratis (promoción)' : ''
            }`;

      try {
        const draft = await this.invoices.create({
          tenantId,
          userId: c.customerId, // marcador: lo lanzo el sistema; en audit se filtrara
          input: {
            invoiceType: 'F1',
            customerId: c.customerId,
            contractId: c.id,
            seriesId: series.id,
            periodStart: cStart.toISOString().slice(0, 10),
            periodEnd: cEnd.toISOString().slice(0, 10),
            dueDate: this.addDays(cEnd, 15).toISOString().slice(0, 10),
            items: [
              {
                description: rentDesc,
                quantity: 1,
                unitPrice: rentUnitPrice,
                taxRate: 21,
                relatedContractId: c.id,
                relatedUnitId: c.unit.id,
                periodStart: cStart.toISOString().slice(0, 10),
                periodEnd: cEnd.toISOString().slice(0, 10),
              },
              // Línea de seguro/protección si el contrato tiene un plan asignado
              // (prepago = prima × N meses, sin descuento de prepago).
              ...(c.insurancePlanId && c.insurancePrice && Number(c.insurancePrice) > 0
                ? [
                    {
                      description: `Protección de contenido${
                        c.insurancePlan?.name ? ` — ${c.insurancePlan.name}` : ''
                      } (${interval > 1 ? `${interval} meses` : cStart.toISOString().slice(0, 7)})`,
                      quantity: 1,
                      unitPrice: Number(c.insurancePrice) * interval,
                      taxRate: Number(c.insurancePlan?.taxRate ?? 21),
                      relatedContractId: c.id,
                      periodStart: cStart.toISOString().slice(0, 10),
                      periodEnd: cEnd.toISOString().slice(0, 10),
                    },
                  ]
                : []),
            ],
            verifactuMode: 'verifactu',
          },
          meta: {},
        });
        // Emisión automática (opt-in): emite el borrador recién creado. Si el
        // issue falla (p. ej. sin serie o Verifactu) NO tumba el lote: la
        // factura queda en draft y se puede emitir a mano.
        if (autoIssue) {
          try {
            await this.invoices.issue({ tenantId, userId: null, invoiceId: draft.id, meta: {} });
          } catch (issueErr) {
            this.logger.warn(
              `auto-issue: no se pudo emitir la factura ${draft.id} (queda en draft): ${
                (issueErr as Error).message
              }`,
            );
          }
        }
        if (isFreeMonth) {
          await this.admin.contract.update({
            where: { id: c.id },
            data: { freeMonthsRemaining: { decrement: 1 } },
          });
        }
        created += 1;
      } catch (err) {
        // Índice parcial invoices_recurring_period_unique: otra réplica/run ya
        // creó la factura de este contrato+periodo → no es un error, se salta.
        if (isUniqueViolation(err)) {
          this.logger.warn(`Factura recurrente duplicada evitada (contrato ${c.id})`);
          continue;
        }
        throw err;
      }
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

  /** Suma N meses conservando el día del mes (para los periodos de prepago). */
  private addMonths(d: Date, months: number): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()));
  }
}
