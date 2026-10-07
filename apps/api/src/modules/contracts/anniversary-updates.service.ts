import { HttpException, Injectable } from '@nestjs/common';

import { AuditService } from '../auth/audit.service';
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
/** Se propone desde 30 días antes del aniversario hasta 60 días después. */
const AHEAD_DAYS = 30;
const BEHIND_DAYS = 60;

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Aniversario que toca revisar para un contrato que empezó en `start`: el más
 * reciente (1 año o más) dentro de la ventana [hoy − 60 d, hoy + 30 d], si aún
 * no se actualizó (o descartó). `null` si no toca. El 29 de febrero cae el 28
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
    const diff = anniversary.getTime() - today.getTime();
    if (diff > AHEAD_DAYS * DAY || diff < -BEHIND_DAYS * DAY) continue;
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
  }): Promise<AnniversarySettingsDto> {
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
            unit: {
              ...(facilityScope ? { facilityId: { in: facilityScope } } : {}),
              ...(settings.scope === 'housing' ? { unitType: { propertyKind: 'housing' } } : {}),
            },
          },
          select: {
            id: true,
            contractNumber: true,
            customerId: true,
            startDate: true,
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
    const due: AnniversaryUpdateDto[] = [];
    for (const r of rows) {
      const anniversary = dueAnniversary(r.startDate, r.lastAnniversaryUpdateOn, midnight);
      if (!anniversary) continue;
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
    const result: ApplyAnniversaryUpdatesResultDto = { applied: 0, skipped: 0, failed: [] };
    for (const contractId of [...new Set(args.input.contractIds)]) {
      const row = due.get(contractId);
      if (!row) {
        result.failed.push({ contractId, error: 'Este contrato no tiene actualización pendiente' });
        continue;
      }
      try {
        if (args.input.action === 'apply' && row.newPrice !== row.currentPrice) {
          await this.contracts.changePrice({
            tenantId: args.tenantId,
            userId: args.userId,
            contractId,
            facilityScope: args.facilityScope ?? null,
            input: {
              priceMonthly: row.newPrice,
              reason: `Actualización anual (${settings.pct > 0 ? '+' : ''}${settings.pct} %) — aniversario ${row.anniversary}`,
            },
            meta: args.meta,
          });
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
