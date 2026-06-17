import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';

import { DOMAIN_EVENTS, type DomainEventPayload } from '../automations/domain-events';
import { PrismaAdminService } from '../database/prisma-admin.service';

/** Ventana de aviso: contratos que vencen en los próximos N días. */
const WINDOW_DAYS = 30;

function displayName(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

/**
 * Emite `domain.contract_ending_soon` para los contratos con `endDate` dentro
 * de la ventana que aún no han sido avisados (idempotente vía
 * `ending_soon_notified_at`). Lo escuchan automations (avisos de renovación /
 * subida de precio) y las notificaciones in-app.
 *
 * Sub-bloque 14A.1: solo se registra cuando `ENABLE_WORKERS_IN_API=true`
 * (corre en el worker en producción).
 */
@Injectable()
export class ContractEndingSoonCron {
  private readonly logger = new Logger(ContractEndingSoonCron.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly events: EventEmitter2,
  ) {}

  @Cron('0 7 * * *', { name: 'contracts.ending-soon' })
  async run(): Promise<{ notified: number }> {
    const now = new Date();
    const until = new Date(now.getTime() + WINDOW_DAYS * 86_400_000);

    const contracts = await this.admin.contract.findMany({
      where: {
        status: { in: ['active', 'ending'] },
        deletedAt: null,
        endingSoonNotifiedAt: null,
        endDate: { not: null, gte: now, lte: until },
      },
      include: {
        customer: {
          select: {
            firstName: true,
            lastName: true,
            companyName: true,
            customerType: true,
            email: true,
            phone: true,
          },
        },
        unit: { select: { code: true, facility: { select: { name: true } } } },
        tenant: { select: { name: true } },
      },
      take: 200,
      orderBy: { endDate: 'asc' },
    });

    let notified = 0;
    for (const c of contracts) {
      const name = displayName(c.customer);
      const payload: DomainEventPayload = {
        tenantId: c.tenantId,
        entityType: 'contract',
        entityId: c.id,
        recipientEmail: c.customer.email ?? null,
        recipientPhone: c.customer.phone ?? null,
        customerId: c.customerId,
        scope: {
          customer: {
            firstName: c.customer.firstName ?? '',
            displayName: name,
            email: c.customer.email ?? '',
          },
          contract: {
            number: c.contractNumber,
            endDate: c.endDate?.toISOString().slice(0, 10) ?? '',
            priceMonthly: Number(c.priceMonthly).toFixed(2),
          },
          unit: { code: c.unit.code },
          facility: { name: c.unit.facility.name },
          tenant: { name: c.tenant.name },
        },
      };
      this.events.emit(DOMAIN_EVENTS.contract_ending_soon, payload);
      await this.admin.contract.update({
        where: { id: c.id },
        data: { endingSoonNotifiedAt: now },
      });
      notified += 1;
    }
    if (notified > 0) this.logger.log(`[contracts] ${notified} avisos de "vence pronto" emitidos`);
    return { notified };
  }
}
