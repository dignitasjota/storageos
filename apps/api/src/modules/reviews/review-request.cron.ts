import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PrismaAdminService } from '../database/prisma-admin.service';

import { ReviewsService } from './reviews.service';

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
 * Auto-solicita la valoración (NPS) N días después de firmar el contrato,
 * para los tenants que lo han activado (`reviewsAutoRequest`). Idempotente:
 * solo contratos sin ninguna review asociada. Opt-in para no enviar emails
 * por sorpresa.
 *
 * Sub-bloque 14A.1: solo se registra cuando `ENABLE_WORKERS_IN_API=true`
 * (corre en el worker en producción).
 */
@Injectable()
export class ReviewRequestCron {
  private readonly logger = new Logger(ReviewRequestCron.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly reviews: ReviewsService,
  ) {}

  @Cron('0 8 * * *', { name: 'reviews.auto-request' })
  async run(): Promise<{ requested: number }> {
    const now = new Date();
    const tenants = await this.admin.tenant.findMany({
      where: { reviewsAutoRequest: true, deletedAt: null },
      select: { id: true, name: true, reviewRequestDelayDays: true },
    });

    let requested = 0;
    for (const tenant of tenants) {
      const threshold = new Date(now.getTime() - tenant.reviewRequestDelayDays * 86_400_000);
      const contracts = await this.admin.contract.findMany({
        where: {
          tenantId: tenant.id,
          deletedAt: null,
          status: { in: ['active', 'ending', 'ended'] },
          signedAt: { not: null, lte: threshold },
          reviews: { none: {} },
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
              deletedAt: true,
            },
          },
          unit: { select: { code: true, facility: { select: { name: true } } } },
        },
        take: 100,
        orderBy: { signedAt: 'asc' },
      });

      for (const c of contracts) {
        if (c.customer.deletedAt || !c.customer.email) continue;
        try {
          await this.reviews.createAndSend({
            tenantId: tenant.id,
            customerId: c.customerId,
            contractId: c.id,
            channel: 'email',
            source: 'reviews.auto',
            recipientEmail: c.customer.email,
            recipientPhone: c.customer.phone,
            tenantName: tenant.name,
            scope: {
              customerFirstName: c.customer.firstName ?? '',
              customerDisplayName: displayName(c.customer),
              contractNumber: c.contractNumber,
              unitCode: c.unit.code,
              facilityName: c.unit.facility.name,
            },
          });
          requested += 1;
        } catch (err) {
          this.logger.warn(
            `[reviews] auto-request contrato ${c.id} falló: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
    if (requested > 0) this.logger.log(`[reviews] auto-request: ${requested} solicitudes enviadas`);
    return { requested };
  }
}
