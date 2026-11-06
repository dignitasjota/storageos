import { BadRequestException, HttpException, Injectable, Logger } from '@nestjs/common';
import { bulkUnitCodes, UNIT_MAX_PRICE } from '@storageos/shared';

import { assertFacilityAllowed } from '../../common/facility-scope';
import { INVOICED_SELECT, INVOICED_STATUSES, invoicedBase } from '../analytics/business-metrics';
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

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

const logger = new Logger('UnitsInventory');

function errorOf(err: unknown): { code: string | null; error: string } {
  if (err instanceof HttpException) {
    const body = err.getResponse() as { code?: string; message?: string };
    return { code: body.code ?? null, error: body.message ?? err.message };
  }
  // Un fallo interno no se enseña: su texto lleva rutas y consultas.
  logger.error(err);
  return { code: null, error: 'No se ha podido hacer' };
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
    const { prices, tenancies, lastFree } = await this.prisma.withTenant(async (tx) => {
      const [prices, tenancies, lastFree] = await Promise.all([
        tx.unitPriceHistory.findMany({
          where: { unitId },
          orderBy: { changedAt: 'desc' },
          take: 50,
          include: { changedBy: { select: { fullName: true } } },
        }),
        tx.unitTenancy.findMany({
          where: { unitId },
          orderBy: [{ startedOn: 'desc' }, { id: 'desc' }],
          include: {
            contract: {
              select: {
                id: true,
                contractNumber: true,
                customerId: true,
                status: true,
                customer: {
                  select: {
                    customerType: true,
                    firstName: true,
                    lastName: true,
                    companyName: true,
                  },
                },
                invoices: {
                  where: {
                    kind: 'invoice',
                    deletedAt: null,
                    status: { in: [...INVOICED_STATUSES] },
                  },
                  select: INVOICED_SELECT,
                },
                unitTenancies: {
                  orderBy: [{ startedOn: 'asc' }, { id: 'asc' }],
                  select: { id: true },
                },
              },
            },
          },
        }),
        tx.unitStatusHistory.findFirst({
          where: { unitId, newStatus: 'available' },
          orderBy: { occurredAt: 'desc' },
          select: { occurredAt: true },
        }),
      ]);
      return { prices, tenancies, lastFree };
    }, tenantId);

    let daysRented = 0;
    let revenue12m = 0;
    const rows = tenancies.map((t) => {
      const begin = Math.max(t.startedOn.getTime(), yearAgo.getTime());
      const endAt = Math.min(t.endedOn?.getTime() ?? now, now);
      if (endAt > begin) daysRented += (endAt - begin) / DAY;
      // Lo facturado por un contrato trasladado se reparte por las fechas de cada
      // tramo; el primero recoge lo anterior al alta y el último lo posterior.
      const others = t.contract.unitTenancies;
      const isFirst = others[0]?.id === t.id;
      const isLast = others[others.length - 1]?.id === t.id;
      const invoices = t.contract.invoices.filter(
        (i) =>
          i.issueDate &&
          (isFirst || i.issueDate >= t.startedOn) &&
          (isLast || !t.endedOn || i.issueDate < t.endedOn),
      );
      for (const i of invoices) {
        if (i.issueDate && i.issueDate >= yearAgo) revenue12m += invoicedBase(i);
      }
      return {
        contractId: t.contract.id,
        contractNumber: t.contract.contractNumber,
        customerId: t.contract.customerId,
        customerName: customerName(t.contract.customer),
        startDate: dayOf(t.startedOn),
        endDate: t.endedOn ? dayOf(t.endedOn) : null,
        status: t.contract.status,
        movedAway: !isLast,
        priceMonthly: Number(t.priceMonthly),
        invoiced: round2(invoices.reduce((sum, i) => sum + invoicedBase(i), 0)),
      };
    });
    const daysVacant =
      unit.status === 'available'
        ? Math.floor((now - (lastFree?.occurredAt ?? new Date(unit.createdAt)).getTime()) / DAY)
        : null;
    // Un trastero dado de alta hace poco no ha podido estar alquilado todo el
    // año; uno importado puede tener inquilinos de antes de su alta.
    const firstKnown = Math.min(
      new Date(unit.createdAt).getTime(),
      ...tenancies.map((t) => t.startedOn.getTime()),
    );
    const daysTracked = Math.min(365, Math.max(1, Math.ceil((now - firstKnown) / DAY)));

    return {
      priceHistory: prices.map((p) => ({
        changedAt: p.changedAt.toISOString(),
        previousPrice: Number(p.previousPrice),
        newPrice: Number(p.newPrice),
        source: p.source,
        userName: p.changedBy?.fullName ?? null,
      })),
      tenancies: rows,
      daysVacant,
      daysRentedLastYear: Math.min(daysTracked, Math.round(daysRented)),
      daysTrackedLastYear: daysTracked,
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
    const unitIds = [...new Set(input.unitIds)];
    const codes = new Map(
      (
        await this.prisma.withTenant(
          (tx) =>
            tx.unit.findMany({
              where: { id: { in: unitIds } },
              select: { id: true, code: true },
            }),
          args.tenantId,
        )
      ).map((u) => [u.id, u.code]),
    );
    for (const unitId of unitIds) {
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
          if (price < 0 || price > UNIT_MAX_PRICE) {
            throw new BadRequestException({
              code: 'invalid_price',
              message: `El precio quedaría en ${price} €: fuera de lo admitido`,
            });
          }
          await this.units.update({ ...base, input: { basePriceMonthly: price } });
        }
        updated += 1;
      } catch (err) {
        failed.push({ unitId, unitCode: codes.get(unitId) ?? null, ...errorOf(err) });
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
    const overLimit: string[] = [];
    const failed: BulkCreateUnitsResultDto['failed'] = [];
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
        const { code: errCode, error } = errorOf(err);
        // El límite del plan corta el resto: no tiene sentido seguir.
        if (errCode === 'units_limit_reached') {
          if (created === 0) throw err;
          overLimit.push(...codes.slice(codes.indexOf(code)));
          break;
        }
        if (errCode === 'unit_code_taken') {
          skipped.push(code);
          continue;
        }
        // Lo creado hasta aquí se queda: se dice dónde se ha parado.
        if (created === 0) throw err;
        failed.push({ code, error });
        break;
      }
    }
    return { created, skipped, overLimit, failed };
  }
}
