import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { firstMonthCents, firstMonthPlan, rentTax } from '@storageos/shared';

import { toCents } from '../../common/money';
import { DOMAIN_EVENTS, type DomainEventPayload } from '../automations/domain-events';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { centsLabel, claimContractCredit } from './contract-credit';
import { InvoiceSeriesService } from './invoice-series.service';
import { InvoicesService } from './invoices.service';

import type { CreateInvoiceItemInput } from '@storageos/shared';

const ymd = (d: Date): string => d.toISOString().slice(0, 10);

/** Motivo legible de un error (los de Nest traen el mensaje en la respuesta). */
function errorMessage(err: unknown): string {
  const response = (err as { response?: { message?: unknown } } | null)?.response;
  if (typeof response?.message === 'string') return response.message.replace(/\.$/, '');
  return err instanceof Error ? err.message : String(err);
}
const eur = (cents: number): string =>
  `${(cents / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

/** Suma meses; si el día no existe en el mes de destino, el último del mes (31 ene + 1 → 28 feb). */
export function addMonths(d: Date, months: number): Date {
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  first.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return first;
}
function addDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

/**
 * Primera factura de un contrato al firmarlo.
 *
 * - Mensual sin cupón: desde el alta hasta fin de mes, prorrateada (encaja con
 *   la recurrente del mes natural). Desde el día que fije el negocio
 *   (`firstPaymentNextMonthFromDay`, 20 por defecto), incluye también el mes
 *   siguiente completo y la recurrente empieza el mes después.
 * - Prepago semestral/anual, primer pago de varios meses o con cupón: cubre
 *   los meses completos desde el alta. Con cupón se descuenta lo que se paga
 *   ahora (los meses gratis salen en una línea a 0 €); después la recurrente
 *   factura mes a mes desde el día siguiente (`billingStartsOn`), salvo el
 *   prepago semestral/anual, que se renueva con su periodo.
 *
 * La fianza va en un justificante aparte, en el mismo pago.
 */
@Injectable()
export class FirstInvoiceService {
  private readonly logger = new Logger(FirstInvoiceService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly invoices: InvoicesService,
    private readonly series: InvoiceSeriesService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * ¿Hay que emitir la 1ª factura al firmar en el panel? Con cupón, varios
   * meses o una entrada a final de mes que incluye el mes siguiente (si no,
   * la recurrente facturaría ese mes por separado a los pocos días).
   */
  async needsOnSign(tenantId: string, contractId: string): Promise<boolean> {
    const c = await this.admin.contract.findFirst({
      where: { id: contractId, tenantId },
      select: {
        startDate: true,
        billingIntervalMonths: true,
        firstPaymentMonths: true,
        tenant: { select: { firstPaymentNextMonthFromDay: true } },
        _count: { select: { couponRedemptions: true } },
      },
    });
    if (!c) return false;
    if (c.firstPaymentMonths > 1 || c._count.couponRedemptions > 0) return true;
    return (
      c.billingIntervalMonths === 1 &&
      firstMonthPlan(ymd(c.startDate), c.tenant.firstPaymentNextMonthFromDay).includesNextMonth
    );
  }

  /** Emite la 1ª factura si el contrato aún no tiene ninguna. No lanza. */
  async issueIfMissing(tenantId: string, contractId: string, customerId: string): Promise<void> {
    let invoice: { id: string } | null = null;
    try {
      const existing = await this.admin.invoice.findFirst({
        where: { tenantId, contractId, deletedAt: null },
        select: { id: true },
      });
      if (existing) return;
      const series = await this.series.getDefault(tenantId);
      if (!series) {
        this.logger.warn(`[first-invoice] tenant ${tenantId} sin serie; no se emite 1ª factura`);
        // Sin factura el inquilino no puede pagar y la reserva caducaría sola:
        // se avisa al equipo para que cree la serie y emita la factura.
        await this.admin.notification
          .create({
            data: {
              tenantId,
              type: 'invoice.first_invoice_missing_series',
              title: 'No se pudo emitir la primera factura',
              body: 'Hay un contrato nuevo sin su primera factura porque no tienes una serie de facturación por defecto. Crea la serie en Configuración → Facturación y emite la factura desde el contrato; si no, el inquilino no puede pagar.',
              link: `/contracts/${contractId}`,
            },
          })
          .catch(() => undefined);
        return;
      }
      const contract = await this.admin.contract.findUniqueOrThrow({
        where: { id: contractId },
        include: {
          unit: { select: { id: true, unitType: { select: { propertyKind: true } } } },
          insurancePlan: { select: { name: true, taxRate: true } },
          couponRedemptions: {
            take: 1,
            include: { coupon: { select: { code: true } } },
          },
        },
      });
      const coupon = contract.couponRedemptions[0] ?? null;
      const interval = contract.billingIntervalMonths;
      const months = interval > 1 ? interval : contract.firstPaymentMonths;
      // Vivienda: alquiler exento de IVA; trastero: 21 %.
      const rent = rentTax(contract.unit.unitType?.propertyKind);
      const fullPrice = Number(contract.priceMonthly) - Number(contract.discountAmount);
      const deposit = Number(contract.depositAmount);
      const cashDeposit = contract.depositPaymentMethod === 'cash';
      const start = new Date(contract.startDate);

      let periodStart: Date;
      let periodEnd: Date;
      const items: CreateInvoiceItemInput[] = [];
      // Desde cuándo factura la recurrente tras esta factura. Se guarda
      // DESPUÉS de crearla: si la emisión falla, la recurrente sigue
      // facturando esos meses en vez de saltárselos.
      let billingStartsOn: Date | null = null;
      // Líneas de alquiler sobre las que se descuenta el saldo a favor.
      let rentLineCount = 1;
      // El primer pago mensual incluye el mes siguiente completo.
      let includesNextMonth = false;
      const line = (description: string, quantity: number, unitPrice: number) => ({
        description,
        quantity,
        unitPrice,
        ...rent,
        relatedContractId: contractId,
        relatedUnitId: contract.unit.id,
        periodStart: ymd(periodStart),
        periodEnd: ymd(periodEnd),
      });

      if (interval > 1 || months > 1 || coupon) {
        // Meses completos desde el alta: [alta, alta + N meses − 1 día].
        periodStart = start;
        periodEnd = addDays(addMonths(start, months), -1);
        const monthCents = toCents(fullPrice);
        const subtotal = monthCents * months;
        const range = `${ymd(periodStart)}–${ymd(periodEnd)}`;
        const monthsLabel = `${months} ${months === 1 ? 'mes' : 'meses'}`;
        if (coupon && coupon.freeMonths > 0) {
          const free = Math.min(coupon.freeMonths, months - 1);
          items.push(
            line(
              `Alquiler ${contract.contractNumber} (${range}, ${monthsLabel})`,
              1,
              (monthCents * (months - free)) / 100,
            ),
            line(
              `${free === 1 ? 'Mes gratis' : `${free} meses gratis`} — cupón ${coupon.coupon.code}`,
              free,
              0,
            ),
          );
        } else if (coupon) {
          const discount = Math.min(toCents(Number(coupon.discountAmount)), subtotal);
          items.push(
            line(
              `Alquiler ${contract.contractNumber} (${range}, ${monthsLabel}; cupón ${
                coupon.coupon.code
              } −${eur(discount)})`,
              1,
              (subtotal - discount) / 100,
            ),
          );
        } else {
          const pct = interval > 1 ? Number(contract.prepayDiscountPct) : 0;
          items.push(
            line(
              `Alquiler ${contract.contractNumber} (${range}, ${monthsLabel}${
                interval > 1 ? ' prepago' : ''
              }${pct > 0 ? ` −${pct}%` : ''})`,
              1,
              Math.round(subtotal * (1 - pct / 100)) / 100,
            ),
          );
        }
        // El seguro se paga por los mismos meses, sin descuento.
        if (
          contract.insurancePlanId &&
          contract.insurancePrice &&
          Number(contract.insurancePrice) > 0
        ) {
          items.push({
            description: `Protección de contenido${
              contract.insurancePlan?.name ? ` — ${contract.insurancePlan.name}` : ''
            } (${monthsLabel})`,
            quantity: 1,
            unitPrice: (toCents(Number(contract.insurancePrice)) * months) / 100,
            taxRate: Number(contract.insurancePlan?.taxRate ?? 21),
            relatedContractId: contractId,
            periodStart: ymd(periodStart),
            periodEnd: ymd(periodEnd),
          });
        }
        // Después de este periodo se factura mes a mes (el prepago
        // semestral/anual se renueva por su cuenta con su periodo).
        if (interval === 1) billingStartsOn = addDays(periodEnd, 1);
      } else {
        // MENSUAL: desde el alta hasta fin del mes natural, prorrateado por
        // días (el día 1, el mes completo). Desde el día que fije el negocio,
        // también el mes siguiente completo: la siguiente cuota no llega a los
        // pocos días.
        const tenant = await this.admin.tenant.findUnique({
          where: { id: tenantId },
          select: { firstPaymentNextMonthFromDay: true },
        });
        const plan = firstMonthPlan(ymd(start), tenant?.firstPaymentNextMonthFromDay ?? null);
        const rentCents = firstMonthCents(toCents(fullPrice), plan);
        periodStart = new Date(`${plan.periodStart}T00:00:00Z`);
        periodEnd = new Date(`${plan.periodEnd}T00:00:00Z`);
        const firstMonthEnd = new Date(
          Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 0),
        );
        items.push({
          ...line(
            plan.fullFirstMonth
              ? `Alquiler ${contract.contractNumber} (${plan.periodStart.slice(0, 7)})`
              : `Alquiler ${contract.contractNumber} (${plan.periodStart}–${ymd(
                  firstMonthEnd,
                )}, prorrateado ${plan.days}/${plan.daysInMonth} d)`,
            1,
            rentCents.firstMonth / 100,
          ),
          periodEnd: ymd(firstMonthEnd),
        });
        if (plan.includesNextMonth && plan.nextMonthStart) {
          items.push({
            ...line(
              `Alquiler ${contract.contractNumber} (${plan.nextMonthStart.slice(0, 7)})`,
              1,
              rentCents.nextMonth / 100,
            ),
            periodStart: plan.nextMonthStart,
          });
        }
        // El seguro de los mismos días (antes la 1ª factura prorrateada no lo
        // llevaba y la recurrente no lo recuperaba).
        if (
          contract.insurancePlanId &&
          contract.insurancePrice &&
          Number(contract.insurancePrice) > 0
        ) {
          const insurance = firstMonthCents(toCents(Number(contract.insurancePrice)), plan);
          items.push({
            description: `Protección de contenido${
              contract.insurancePlan?.name ? ` — ${contract.insurancePlan.name}` : ''
            } (${plan.periodStart}–${plan.periodEnd})`,
            quantity: 1,
            unitPrice: insurance.total / 100,
            taxRate: Number(contract.insurancePlan?.taxRate ?? 21),
            relatedContractId: contractId,
            periodStart: plan.periodStart,
            periodEnd: plan.periodEnd,
          });
        }
        if (plan.includesNextMonth) {
          includesNextMonth = true;
          rentLineCount = 2;
          billingStartsOn = new Date(`${plan.billingStartsOn}T00:00:00Z`);
        }
      }

      // Descuento pendiente del contrato (la señal de la reserva ya cobrada): se
      // resta del alquiler de esta primera factura (de las dos líneas si
      // incluye el mes siguiente: primero los días del mes de entrada, después
      // el mes siguiente).
      const rentLines = items.slice(0, rentLineCount);
      const rentCentsTotal = rentLines.reduce(
        (sum, l) => sum + toCents(l.unitPrice) * l.quantity,
        0,
      );
      const credit =
        rentLines.length > 0
          ? await claimContractCredit(this.admin, contractId, rentCentsTotal)
          : null;
      if (credit && credit.cents > 0) {
        let remaining = credit.cents;
        for (const rentLine of rentLines) {
          if (remaining <= 0) break;
          const lineCents = toCents(rentLine.unitPrice) * rentLine.quantity;
          const applied = Math.min(lineCents, remaining);
          remaining -= applied;
          rentLine.unitPrice = (lineCents - applied) / 100;
          rentLine.quantity = 1;
          rentLine.description = `${rentLine.description} — descontados ${centsLabel(applied)} (${
            credit.reason ?? 'saldo a favor'
          })`;
        }
      }

      // Un mes: vence a los 15 días del fin del mes (como la recurrente). Varios
      // meses por adelantado: a los 15 días del inicio (si no, un anual vencía
      // al cabo de un año y no entraba nunca en impagos).
      // Con el mes siguiente incluido, igual que varios meses.
      const dueDate =
        months > 1 || includesNextMonth ? addDays(periodStart, 15) : addDays(periodEnd, 15);
      invoice = await this.invoices
        .create({
          tenantId,
          userId: null,
          input: {
            invoiceType: 'F1',
            customerId,
            contractId,
            seriesId: series.id,
            periodStart: ymd(periodStart),
            periodEnd: ymd(periodEnd),
            dueDate: ymd(dueDate),
            items,
            verifactuMode: 'verifactu',
          },
          meta: {},
        })
        .catch(async (err: unknown) => {
          await credit?.restore().catch(() => undefined);
          throw err;
        });
      if (billingStartsOn) {
        await this.admin.contract.update({
          where: { id: contractId },
          data: { billingStartsOn },
        });
      }
      await this.invoices.issue({ tenantId, userId: null, invoiceId: invoice.id, meta: {} });
      if (coupon) {
        await this.admin.couponRedemption.update({
          where: { id: coupon.id },
          data: { invoiceId: invoice.id },
        });
      }
      if (deposit > 0) {
        await this.invoices.createDepositReceipt({
          tenantId,
          userId: null,
          contractId,
          customerId,
          contractNumber: contract.contractNumber,
          amount: deposit,
          // En efectivo: se cobra en el local, aparte del pago online (el acceso
          // llega con la factura pagada) y sin vencimiento (no entra en impagos).
          ...(cashDeposit
            ? { dueDate: null, bundledWithInvoiceId: null }
            : { dueDate, bundledWithInvoiceId: invoice.id }),
        });
      }
      // Alquiler a 0 € (cupón del 100 % o que cubre todo el periodo): no hay nada
      // que cobrar, así que queda saldada (después de crear la fianza, para que el
      // acceso espere a que se pague). La fianza se paga sola en el portal.
      await this.settleIfZero(tenantId, invoice.id);
    } catch (err) {
      const reason = errorMessage(err);
      this.logger.error(
        `[first-invoice] no se pudo emitir la 1ª factura del contrato ${contractId}: ${reason}`,
      );
      // Sin factura el inquilino no puede pagar y la reserva caduca sola: el
      // equipo tiene que saberlo (p. ej. un NIF que la AEAT no admite).
      await this.admin.notification
        .create({
          data: {
            tenantId,
            type: 'invoice.first_invoice_failed',
            title: 'No se pudo emitir la primera factura',
            body: `${reason}. Corrígelo y emite la factura${
              invoice ? '' : ' desde el contrato'
            }; si no, el inquilino no puede pagar y la reserva caduca.`,
            link: invoice ? `/invoices/${invoice.id}` : `/contracts/${contractId}`,
          },
        })
        .catch(() => undefined);
    }
  }

  /**
   * Una factura de 0 € no se puede cobrar: se marca pagada y se avisa como un
   * pago (da el acceso de la reserva online; el correo de «pago recibido» no
   * sale por importes de 0 €).
   */
  private async settleIfZero(tenantId: string, invoiceId: string): Promise<void> {
    const inv = await this.admin.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        total: true,
        invoiceNumber: true,
        customerId: true,
        customer: { select: { email: true } },
      },
    });
    if (!inv || toCents(Number(inv.total)) !== 0) return;
    const paidAt = new Date();
    const flipped = await this.admin.invoice.updateMany({
      where: { id: invoiceId, status: { in: ['issued', 'overdue'] } },
      data: { status: 'paid', paidAt },
    });
    if (flipped.count === 0) return;
    const payload: DomainEventPayload = {
      tenantId,
      entityType: 'invoice',
      entityId: invoiceId,
      customerId: inv.customerId,
      recipientEmail: inv.customer?.email ?? null,
      scope: {
        invoice: { number: inv.invoiceNumber, total: '0.00', paidAt: paidAt.toISOString() },
      },
    };
    this.events.emit(DOMAIN_EVENTS.invoice_paid, payload);
  }
}
