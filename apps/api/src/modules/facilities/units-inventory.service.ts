import { HttpException, Injectable } from '@nestjs/common';
import { bulkUnitCodes } from '@storageos/shared';

import { assertFacilityAllowed } from '../../common/facility-scope';
import { PrismaService } from '../database/prisma.service';

import { UnitsService } from './units.service';

import type { RequestMeta } from '../auth/auth.service';
import type {
  BulkCreateUnitsInput,
  BulkCreateUnitsResultDto,
  BulkUnitsActionInput,
  BulkUnitsResultDto,
  UnitInsightsDto,
} from '@storageos/shared';

const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

function customerName(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Cliente';
}

function errorOf(err: unknown): { code: string | null; error: string } {
  if (err instanceof HttpException) {
    const body = err.getResponse() as { code?: string; message?: string };
    return { code: body.code ?? null, error: body.message ?? err.message };
  }
  return { code: null, error: err instanceof Error ? err.message : String(err) };
}

/**
 * Lo que se hace sobre varios trasteros a la vez (cambios en lote y alta
 * masiva) y la ficha ampliada de un trastero. Cada trastero pasa por las
 * mismas reglas que uno a uno (`UnitsService`).
 */
@Injectable()
export class UnitsInventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly units: UnitsService,
  ) {}

  async insights(
    tenantId: string,
    unitId: string,
    facilityScope?: string[] | null,
  ): Promise<UnitInsightsDto> {
    const unit = await this.units.detail(tenantId, unitId, facilityScope);
    const now = Date.now();
    const yearAgo = new Date(now - 365 * DAY);
    const { prices, contracts, lastFree } = await this.prisma.withTenant(async (tx) => {
      const [prices, contracts, lastFree] = await Promise.all([
        tx.unitPriceHistory.findMany({
          where: { unitId },
          orderBy: { changedAt: 'desc' },
          take: 50,
          include: { changedBy: { select: { fullName: true } } },
        }),
        tx.contract.findMany({
          where: { unitId, deletedAt: null, signedAt: { not: null } },
          orderBy: { startDate: 'desc' },
          select: {
            id: true,
            contractNumber: true,
            customerId: true,
            startDate: true,
            endDate: true,
            endedAt: true,
            cancelledAt: true,
            status: true,
            priceMonthly: true,
            signedAt: true,
            customer: {
              select: { customerType: true, firstName: true, lastName: true, companyName: true },
            },
            invoices: {
              where: {
                kind: 'invoice',
                deletedAt: null,
                status: { notIn: ['draft', 'cancelled'] },
              },
              select: { total: true, issueDate: true },
            },
          },
        }),
        tx.unitStatusHistory.findFirst({
          where: { unitId, newStatus: 'available' },
          orderBy: { occurredAt: 'desc' },
          select: { occurredAt: true },
        }),
      ]);
      return { prices, contracts, lastFree };
    }, tenantId);

    let daysRented = 0;
    let revenue12m = 0;
    for (const c of contracts) {
      const begin = Math.max((c.signedAt ?? c.startDate).getTime(), yearAgo.getTime());
      const endAt =
        c.status === 'active' || c.status === 'ending'
          ? now
          : ((c.endedAt ?? c.cancelledAt ?? c.endDate)?.getTime() ?? now);
      if (endAt > begin) daysRented += (endAt - begin) / DAY;
      for (const i of c.invoices)
        if (i.issueDate && i.issueDate >= yearAgo) revenue12m += Number(i.total);
    }
    const daysVacant =
      unit.status === 'available'
        ? Math.floor((now - (lastFree?.occurredAt ?? new Date(unit.createdAt)).getTime()) / DAY)
        : null;

    return {
      priceHistory: prices.map((p) => ({
        changedAt: p.changedAt.toISOString(),
        previousPrice: Number(p.previousPrice),
        newPrice: Number(p.newPrice),
        source: p.source,
        userName: p.changedBy?.fullName ?? null,
      })),
      tenancies: contracts.map((c) => ({
        contractId: c.id,
        contractNumber: c.contractNumber,
        customerId: c.customerId,
        customerName: customerName(c.customer),
        startDate: c.startDate.toISOString().slice(0, 10),
        endDate: (c.endedAt ?? c.cancelledAt ?? c.endDate)?.toISOString().slice(0, 10) ?? null,
        status: c.status,
        priceMonthly: Number(c.priceMonthly),
        invoiced: round2(c.invoices.reduce((sum, i) => sum + Number(i.total), 0)),
      })),
      daysVacant,
      daysRentedLastYear: Math.min(365, Math.round(daysRented)),
      revenue12m: round2(revenue12m),
      revenuePerM2: unit.areaM2 > 0 ? round2(revenue12m / unit.areaM2) : null,
      maintenanceUntil: unit.maintenanceUntil,
    };
  }

  /** Cambia estado, tipo, planta o precio de varios trasteros (cada uno por su cuenta). */
  async bulk(args: {
    tenantId: string;
    userId: string;
    input: BulkUnitsActionInput;
    meta: RequestMeta;
    facilityScope?: string[] | null;
  }): Promise<BulkUnitsResultDto> {
    const { input } = args;
    const failed: BulkUnitsResultDto['failed'] = [];
    let updated = 0;
    for (const unitId of [...new Set(input.unitIds)]) {
      try {
        const base = {
          tenantId: args.tenantId,
          userId: args.userId,
          unitId,
          meta: args.meta,
          facilityScope: args.facilityScope ?? null,
        };
        if (input.action === 'status') {
          await this.units.changeStatus({
            ...base,
            input: { status: input.status, ...(input.reason ? { reason: input.reason } : {}) },
          });
        } else if (input.action === 'type') {
          await this.units.update({ ...base, input: { unitTypeId: input.unitTypeId } });
        } else if (input.action === 'floor') {
          await this.units.update({ ...base, input: { floorId: input.floorId } });
        } else {
          const current = await this.units.detail(args.tenantId, unitId, args.facilityScope);
          const price =
            input.mode === 'set'
              ? input.value
              : round2(current.basePriceMonthly * (1 + input.value / 100));
          if (price < 0) throw new Error('El precio no puede ser negativo');
          await this.units.update({ ...base, input: { basePriceMonthly: price } });
        }
        updated += 1;
      } catch (err) {
        failed.push({ unitId, ...errorOf(err) });
      }
    }
    return { updated, failed };
  }

  /** Alta de N trasteros seguidos («A-01» … «A-20»); los códigos que ya existen se saltan. */
  async bulkCreate(args: {
    tenantId: string;
    userId: string;
    input: BulkCreateUnitsInput;
    meta: RequestMeta;
    facilityScope?: string[] | null;
  }): Promise<BulkCreateUnitsResultDto> {
    const { input } = args;
    assertFacilityAllowed(args.facilityScope, input.facilityId);
    const codes = bulkUnitCodes({
      prefix: input.prefix,
      start: input.start,
      count: input.count,
      padding: input.padding ?? 2,
    });
    let created = 0;
    const skipped: string[] = [];
    for (const code of codes) {
      try {
        await this.units.create({
          tenantId: args.tenantId,
          userId: args.userId,
          meta: args.meta,
          input: {
            facilityId: input.facilityId,
            ...(input.floorId ? { floorId: input.floorId } : {}),
            unitTypeId: input.unitTypeId,
            code,
            widthM: input.widthM,
            depthM: input.depthM,
            heightM: input.heightM,
            ...(input.basePriceMonthly !== undefined
              ? { basePriceMonthly: input.basePriceMonthly }
              : {}),
          },
        });
        created += 1;
      } catch (err) {
        const { code: errCode } = errorOf(err);
        // El límite del plan corta el resto: no tiene sentido seguir.
        if (errCode === 'units_limit_reached') {
          if (created === 0) throw err;
          skipped.push(...codes.slice(codes.indexOf(code)));
          break;
        }
        if (errCode !== 'unit_code_taken') throw err;
        skipped.push(code);
      }
    }
    return { created, skipped };
  }
}
