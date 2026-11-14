import { ForbiddenException, HttpException, Injectable } from '@nestjs/common';

import { todayInTimezone } from '../../common/format';
import { STARTED_CONTRACT_WHERE } from '../../common/pre-opening';
import { pendingPriceChanges } from '../../common/price-changes';
import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import { ContractsService } from './contracts.service';

import type { RequestMeta } from '../auth/auth.service';
import type {
  AnniversarySettingsDto,
  AnniversaryUpdateDto,
  ApplyAnniversaryUpdatesInput,
  ApplyAnniversaryUpdatesResultDto,
  UpdateAnniversarySettingsInput,
} from '@storageos/shared';

const DAY = 86_400_000;
/** Se propone desde 30 días antes del aniversario hasta que se revisa (o llega el siguiente). */
const AHEAD_DAYS = 30;
/** Pasados estos días sin revisar, se marca como atrasado. */
const LATE_DAYS = 30;

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Aniversario que toca revisar para un contrato que empezó en `start`: el más
 * reciente (1 año o más) que ya ha llegado o llega en 30 días, si aún no se
 * actualizó (o descartó). No caduca: sigue propuesto hasta que se revisa o
 * entra el del año siguiente. `null` si no toca. El 29 de febrero cae el 28
 * los años no bisiestos.
 */
export function dueAnniversary(start: Date, lastUpdatedOn: Date | null, today: Date): Date | null {
  const day = start.getUTCDate();
  const month = start.getUTCMonth();
  for (const year of [
    today.getUTCFullYear() + 1,
    today.getUTCFullYear(),
    today.getUTCFullYear() - 1,
  ]) {
    if (year <= start.getUTCFullYear()) continue;
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const anniversary = new Date(Date.UTC(year, month, Math.min(day, last)));
    if (anniversary.getTime() - today.getTime() > AHEAD_DAYS * DAY) continue;
    if (lastUpdatedOn && lastUpdatedOn.getTime() >= anniversary.getTime()) return null;
    return anniversary;
  }
  return null;
}

/** Renta nueva tras aplicar el porcentaje, en céntimos redondeados. */
export function anniversaryPrice(current: number, pct: number): number {
  return Math.round(current * (1 + pct / 100) * 100) / 100;
}

/**
 * Actualización anual de la renta en el aniversario de cada contrato con el %
 * que fija el tenant (índice pactado en el contrato). El sistema solo propone:
 * el gestor la aplica o la descarta para ese año.
 */
@Injectable()
export class AnniversaryUpdatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly contracts: ContractsService,
    private readonly audit: AuditService,
  ) {}

  async getSettings(tenantId: string): Promise<AnniversarySettingsDto> {
    const t = await this.prisma.withTenant(
      (tx) =>
        tx.tenant.findUniqueOrThrow({
          where: { id: tenantId },
          select: {
            anniversaryUpdateEnabled: true,
            anniversaryUpdatePct: true,
            anniversaryUpdateScope: true,
          },
        }),
      tenantId,
    );
    return {
      enabled: t.anniversaryUpdateEnabled,
      pct: Number(t.anniversaryUpdatePct),
      scope: t.anniversaryUpdateScope === 'all' ? 'all' : 'housing',
    };
  }

  async updateSettings(args: {
    tenantId: string;
    userId: string;
    input: UpdateAnniversarySettingsInput;
    facilityScope?: string[] | null;
  }): Promise<AnniversarySettingsDto> {
    if (args.facilityScope) {
      throw new ForbiddenException({
        code: 'requires_all_facilities',
        message:
          'Este ajuste es de toda la empresa: solo puede cambiarlo quien ve todos los locales',
      });
    }
    await this.prisma.withTenant(
      (tx) =>
        tx.tenant.update({
          where: { id: args.tenantId },
          data: {
            anniversaryUpdateEnabled: args.input.enabled,
            anniversaryUpdatePct: args.input.pct,
            anniversaryUpdateScope: args.input.scope,
          },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.anniversary_settings_changed',
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes: { ...args.input },
    });
    return this.getSettings(args.tenantId);
  }

  /** Contratos cuyo aniversario toca revisar ahora. */
  async listDue(
    tenantId: string,
    facilityScope?: string[] | null,
    today = new Date(),
  ): Promise<AnniversaryUpdateDto[]> {
    const settings = await this.getSettings(tenantId);
    if (!settings.enabled) return [];
    const midnight = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
    );
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findMany({
          where: {
            status: { in: ['active', 'ending'] },
            deletedAt: null,
            ...STARTED_CONTRACT_WHERE,
            unit: {
              ...(facilityScope ? { facilityId: { in: facilityScope } } : {}),
              ...(settings.scope === 'housing' ? { unitType: { propertyKind: 'housing' } } : {}),
            },
          },
          select: {
            id: true,
            contractNumber: true,
            customerId: true,
            status: true,
            startDate: true,
            endDate: true,
            autoRenew: true,
            priceMonthly: true,
            lastAnniversaryUpdateOn: true,
            customer: {
              select: { firstName: true, lastName: true, companyName: true, customerType: true },
            },
            unit: { select: { code: true, unitType: { select: { propertyKind: true } } } },
          },
        }),
      tenantId,
    );
    const ids = rows.map((r) => r.id);
    const [changes, raises] = await Promise.all([
      pendingPriceChanges(this.admin, tenantId, { contractIds: ids }),
      this.prisma.withTenant(
        (tx) =>
          tx.contractEvent.findMany({
            where: {
              contractId: { in: ids },
              eventType: 'price_changed',
              occurredAt: { gte: new Date(midnight.getTime() - 365 * DAY) },
            },
            select: { contractId: true, payload: true, occurredAt: true },
          }),
        tenantId,
      ),
    ]);
    const raisesBy = new Map<string, Date[]>();
    for (const e of raises) {
      const p = (e.payload ?? {}) as { from?: unknown; to?: unknown };
      if (!(Number(p.to) > Number(p.from))) continue;
      raisesBy.set(e.contractId, [...(raisesBy.get(e.contractId) ?? []), e.occurredAt]);
    }
    const due: AnniversaryUpdateDto[] = [];
    for (const r of rows) {
      const anniversary = dueAnniversary(r.startDate, r.lastAnniversaryUpdateOn, midnight);
      if (!anniversary) continue;
      // Ya tiene otro cambio de cuota en marcha: no se propone otro encima.
      if ((changes.get(r.id) ?? []).length > 0) continue;
      // Se va antes del aniversario.
      if (r.endDate && r.endDate < anniversary && (r.status === 'ending' || !r.autoRenew)) {
        continue;
      }
      // Ya se le subió la cuota para este aniversario (al renovar, con una tanda…).
      const contractRaises = raisesBy.get(r.id) ?? [];
      if (contractRaises.some((at) => at.getTime() >= anniversary.getTime() - AHEAD_DAYS * DAY)) {
        continue;
      }
      const current = Number(r.priceMonthly);
      due.push({
        contractId: r.id,
        contractNumber: r.contractNumber,
        customerId: r.customerId,
        customerName:
          r.customer.customerType === 'business'
            ? (r.customer.companyName ?? 'Empresa')
            : [r.customer.firstName, r.customer.lastName].filter(Boolean).join(' '),
        unitCode: r.unit.code,
        propertyKind: r.unit.unitType.propertyKind === 'housing' ? 'housing' : 'storage',
        anniversary: iso(anniversary),
        currentPrice: current,
        newPrice: anniversaryPrice(current, settings.pct),
        late: anniversary.getTime() < midnight.getTime() - LATE_DAYS * DAY,
        raisedThisYear: contractRaises.length > 0,
      });
    }
    return due.sort((a, b) => a.anniversary.localeCompare(b.anniversary));
  }

  /** Aplica (o descarta para este año) la actualización de los contratos indicados. */
  async apply(args: {
    tenantId: string;
    userId: string;
    input: ApplyAnniversaryUpdatesInput;
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<ApplyAnniversaryUpdatesResultDto> {
    const settings = await this.getSettings(args.tenantId);
    const due = new Map(
      (await this.listDue(args.tenantId, args.facilityScope)).map((d) => [d.contractId, d]),
    );
    const result: ApplyAnniversaryUpdatesResultDto = {
      applied: 0,
      scheduled: 0,
      skipped: 0,
      failed: [],
    };
    const today = iso(todayInTimezone('Europe/Madrid'));
    for (const contractId of [...new Set(args.input.contractIds)]) {
      const row = due.get(contractId);
      if (!row) {
        result.failed.push({ contractId, error: 'Este contrato no tiene actualización pendiente' });
        continue;
      }
      try {
        // Desde el aniversario (programada si aún no ha llegado) y con aviso al inquilino.
        const future = row.anniversary > today;
        if (args.input.action === 'apply' && row.newPrice !== row.currentPrice) {
          await this.contracts.changePrice({
            tenantId: args.tenantId,
            userId: args.userId,
            contractId,
            facilityScope: args.facilityScope ?? null,
            input: {
              priceMonthly: row.newPrice,
              reason: `Actualización anual (${settings.pct > 0 ? '+' : ''}${settings.pct} %) — aniversario ${row.anniversary}`,
              ...(future ? { effectiveDate: row.anniversary } : {}),
              notifyCustomer: true,
            },
            meta: args.meta,
          });
          if (future) result.scheduled = (result.scheduled ?? 0) + 1;
        }
        await this.prisma.withTenant(
          (tx) =>
            tx.contract.update({
              where: { id: contractId },
              data: { lastAnniversaryUpdateOn: new Date(`${row.anniversary}T00:00:00.000Z`) },
            }),
          args.tenantId,
        );
        if (args.input.action === 'apply') result.applied += 1;
        else result.skipped += 1;
      } catch (err) {
        result.failed.push({
          contractId,
          error:
            err instanceof HttpException
              ? ((err.getResponse() as { message?: string }).message ?? err.message)
              : err instanceof Error
                ? err.message
                : String(err),
        });
      }
    }
    return result;
  }
}
