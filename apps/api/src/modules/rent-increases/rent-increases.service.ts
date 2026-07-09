import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { CommunicationsService } from '../communications/communications.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import type { Prisma } from '@storageos/database';
import type {
  CreateRentIncreaseInput,
  PreviewRentIncreaseInput,
  RentIncreaseAffectedContract,
  RentIncreaseDto,
  RentIncreaseItemDto,
  RentIncreasePolicyDto,
  RentIncreasePolicyInput,
  RentIncreasePreviewDto,
  RentIncreaseScopeInput,
} from '@storageos/shared';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function customerName(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

type RentIncreaseRow = Prisma.RentIncreaseGetPayload<object>;

const AFFECTED_INCLUDE = {
  customer: {
    select: { customerType: true, firstName: true, lastName: true, companyName: true, email: true },
  },
  unit: { select: { code: true, facilityId: true, unitTypeId: true } },
} satisfies Prisma.ContractInclude;

@Injectable()
export class RentIncreasesService {
  private readonly logger = new Logger(RentIncreasesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly communications: CommunicationsService,
  ) {}

  async getPolicy(tenantId: string): Promise<RentIncreasePolicyDto> {
    const t = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { rentIncreaseMaxAnnualPct: true, rentIncreaseMinMonthsBetween: true },
    });
    return {
      maxAnnualPct: Number(t?.rentIncreaseMaxAnnualPct ?? 0),
      minMonthsBetween: t?.rentIncreaseMinMonthsBetween ?? 12,
    };
  }

  async updatePolicy(
    tenantId: string,
    input: RentIncreasePolicyInput,
  ): Promise<RentIncreasePolicyDto> {
    const data: { rentIncreaseMaxAnnualPct?: number; rentIncreaseMinMonthsBetween?: number } = {};
    if (input.maxAnnualPct !== undefined) data.rentIncreaseMaxAnnualPct = input.maxAnnualPct;
    if (input.minMonthsBetween !== undefined)
      data.rentIncreaseMinMonthsBetween = input.minMonthsBetween;
    if (Object.keys(data).length > 0) {
      await this.admin.tenant.update({ where: { id: tenantId }, data });
    }
    return this.getPolicy(tenantId);
  }

  private computeNewPrice(oldPrice: number, type: string, value: number, maxAnnualPct = 0): number {
    let next = type === 'percentage' ? oldPrice * (1 + value / 100) : oldPrice + value;
    // Tope anual: una subida no puede superar el % máximo configurado.
    if (maxAnnualPct > 0 && next > oldPrice) {
      next = Math.min(next, oldPrice * (1 + maxAnnualPct / 100));
    }
    return round2(next);
  }

  /** Contratos active/ending que cumplen el scope, con su precio nuevo. */
  private async resolveAffected(
    tenantId: string,
    scope: RentIncreaseScopeInput,
    type: string,
    value: number,
  ) {
    const where: Prisma.ContractWhereInput = {
      tenantId,
      deletedAt: null,
      status: { in: ['active', 'ending'] },
      signedAt: { not: null },
    };
    if (scope.minMonthsSinceSigned > 0) {
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - scope.minMonthsSinceSigned);
      where.signedAt = { not: null, lte: cutoff };
    }
    if (scope.facilityId || scope.unitTypeId) {
      where.unit = {
        ...(scope.facilityId ? { facilityId: scope.facilityId } : {}),
        ...(scope.unitTypeId ? { unitTypeId: scope.unitTypeId } : {}),
      };
    }

    // Política del tenant: tope % anual + meses mínimos entre subidas al mismo
    // contrato (para no solapar subidas recientes).
    const policy = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { rentIncreaseMaxAnnualPct: true, rentIncreaseMinMonthsBetween: true },
    });
    const maxAnnualPct = Number(policy?.rentIncreaseMaxAnnualPct ?? 0);
    const minMonths = policy?.rentIncreaseMinMonthsBetween ?? 0;

    // Contratos con una subida ya aplicada dentro de la ventana → se excluyen.
    let recentlyRaised = new Set<string>();
    if (minMonths > 0) {
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - minMonths);
      const recent = await this.prisma.withTenant(
        (tx) =>
          tx.rentIncreaseItem.findMany({
            where: { status: 'applied', appliedAt: { gte: cutoff } },
            select: { contractId: true },
          }),
        tenantId,
      );
      recentlyRaised = new Set(recent.map((r) => r.contractId));
    }

    const contracts = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findMany({
          where,
          include: AFFECTED_INCLUDE,
          orderBy: { contractNumber: 'asc' },
        }),
      tenantId,
    );
    return contracts
      .filter((c) => !recentlyRaised.has(c.id))
      .map((c) => {
        const oldPrice = Number(c.priceMonthly);
        return {
          contractId: c.id,
          contractNumber: c.contractNumber,
          customerName: customerName(c.customer),
          customerEmail: c.customer.email,
          customerFirstName: c.customer.firstName ?? c.customer.companyName ?? 'cliente',
          unitCode: c.unit.code,
          oldPrice,
          newPrice: this.computeNewPrice(oldPrice, type, value, maxAnnualPct),
        };
      });
  }

  async preview(
    tenantId: string,
    input: PreviewRentIncreaseInput,
  ): Promise<RentIncreasePreviewDto> {
    const affected = await this.resolveAffected(
      tenantId,
      input.scope,
      input.increaseType,
      input.increaseValue,
    );
    const contracts: RentIncreaseAffectedContract[] = affected.map((a) => ({
      contractId: a.contractId,
      contractNumber: a.contractNumber,
      customerName: a.customerName,
      unitCode: a.unitCode,
      oldPrice: a.oldPrice,
      newPrice: a.newPrice,
    }));
    const mrrDelta = round2(affected.reduce((s, a) => s + (a.newPrice - a.oldPrice), 0));
    return { affectedCount: affected.length, mrrDelta, contracts };
  }

  async create(args: {
    tenantId: string;
    userId: string;
    input: CreateRentIncreaseInput;
  }): Promise<RentIncreaseDto> {
    const { tenantId, input } = args;
    const affected = await this.resolveAffected(
      tenantId,
      input.scope,
      input.increaseType,
      input.increaseValue,
    );
    if (affected.length === 0) {
      throw new BadRequestException({
        code: 'no_contracts_affected',
        message: 'Ningún contrato cumple los criterios seleccionados',
      });
    }
    const mrrDelta = round2(affected.reduce((s, a) => s + (a.newPrice - a.oldPrice), 0));

    const created = await this.prisma.withTenant(
      (tx) =>
        tx.rentIncrease.create({
          data: {
            tenantId,
            name: input.name,
            scope: input.scope as Prisma.InputJsonValue,
            increaseType: input.increaseType,
            increaseValue: input.increaseValue,
            effectiveDate: new Date(`${input.effectiveDate}T00:00:00Z`),
            status: 'scheduled',
            affectedCount: affected.length,
            mrrDelta,
            createdByUserId: args.userId,
            items: {
              create: affected.map((a) => ({
                tenantId,
                contractId: a.contractId,
                oldPrice: a.oldPrice,
                newPrice: a.newPrice,
                status: 'pending',
              })),
            },
          },
        }),
      tenantId,
    );

    // Preaviso por email (best-effort) a cada inquilino afectado.
    const tenantName =
      (await this.admin.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }))
        ?.name ?? '';
    const effectiveLabel = new Date(`${input.effectiveDate}T00:00:00Z`).toLocaleDateString(
      'es-ES',
      {
        timeZone: 'UTC',
      },
    );
    let noticeSent = false;
    for (const a of affected) {
      if (!a.customerEmail) continue;
      try {
        await this.communications.enqueue({
          tenantId,
          channel: 'email',
          recipient: a.customerEmail,
          subject: `Revisión de tu cuota mensual — ${tenantName}`,
          bodyText:
            `Hola ${a.customerFirstName},\n\n` +
            `Te informamos de que, a partir del ${effectiveLabel}, la cuota mensual de tu trastero ${a.unitCode} ` +
            `pasará de ${a.oldPrice.toFixed(2)} € a ${a.newPrice.toFixed(2)} €.\n\n` +
            `Si tienes cualquier duda, responde a este correo.\n\nGracias por confiar en ${tenantName}.`,
          source: `rent_increase:${created.id}`,
        });
        noticeSent = true;
      } catch (err) {
        this.logger.warn(
          `[rent-increase] aviso a ${a.customerEmail} falló: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    if (noticeSent) {
      await this.prisma.withTenant(
        (tx) => tx.rentIncrease.update({ where: { id: created.id }, data: { noticeSent: true } }),
        tenantId,
      );
    }

    return this.detail(tenantId, created.id);
  }

  /** Aplica una tanda: sube el precio de cada contrato pendiente. Idempotente. */
  async apply(tenantId: string, id: string): Promise<RentIncreaseDto> {
    const increase = await this.findRow(tenantId, id);
    if (increase.status === 'cancelled') {
      throw new BadRequestException({
        code: 'rent_increase_cancelled',
        message: 'La tanda está cancelada',
      });
    }

    await this.prisma.withTenant(async (tx) => {
      const items = await tx.rentIncreaseItem.findMany({
        where: { rentIncreaseId: id, status: 'pending' },
        include: { contract: { select: { status: true, priceMonthly: true } } },
      });
      let applied = 0;
      for (const item of items) {
        const c = item.contract;
        if (!c || (c.status !== 'active' && c.status !== 'ending')) {
          await tx.rentIncreaseItem.update({
            where: { id: item.id },
            data: { status: 'skipped', skipReason: 'contract_not_active' },
          });
          continue;
        }
        await tx.contract.update({
          where: { id: item.contractId },
          data: { priceMonthly: item.newPrice },
        });
        await tx.contractEvent.create({
          data: {
            tenantId,
            contractId: item.contractId,
            eventType: 'price_changed',
            payload: {
              from: Number(item.oldPrice),
              to: Number(item.newPrice),
              reason: `rent_increase:${id}`,
            },
          },
        });
        await tx.rentIncreaseItem.update({
          where: { id: item.id },
          data: { status: 'applied', appliedAt: new Date() },
        });
        applied += 1;
      }
      const totalApplied = await tx.rentIncreaseItem.count({
        where: { rentIncreaseId: id, status: 'applied' },
      });
      await tx.rentIncrease.update({
        where: { id },
        data: { status: 'applied', appliedAt: new Date(), appliedCount: totalApplied },
      });
      this.logger.log(`[rent-increase] ${id} aplicada: +${applied} contratos`);
    }, tenantId);

    return this.detail(tenantId, id);
  }

  async cancel(tenantId: string, id: string): Promise<RentIncreaseDto> {
    const increase = await this.findRow(tenantId, id);
    if (increase.status !== 'scheduled') {
      throw new BadRequestException({
        code: 'rent_increase_not_cancellable',
        message: 'Solo se puede cancelar una tanda programada',
      });
    }
    await this.prisma.withTenant(
      (tx) => tx.rentIncrease.update({ where: { id }, data: { status: 'cancelled' } }),
      tenantId,
    );
    return this.detail(tenantId, id);
  }

  /** Llamado por el cron: aplica todas las tandas programadas cuya fecha llegó. */
  async applyDue(reference: Date = new Date()): Promise<{ applied: number }> {
    const due = await this.admin.rentIncrease.findMany({
      where: { status: 'scheduled', effectiveDate: { lte: reference } },
      select: { id: true, tenantId: true },
      take: 200,
    });
    let applied = 0;
    for (const ri of due) {
      try {
        await this.apply(ri.tenantId, ri.id);
        applied += 1;
      } catch (err) {
        this.logger.error(
          `[rent-increase] aplicar ${ri.id} falló: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return { applied };
  }

  async list(tenantId: string): Promise<RentIncreaseDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) => tx.rentIncrease.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async detail(tenantId: string, id: string): Promise<RentIncreaseDto> {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.rentIncrease.findFirst({
          where: { id, tenantId },
          include: {
            items: {
              orderBy: { oldPrice: 'desc' },
              include: {
                contract: {
                  select: {
                    contractNumber: true,
                    customer: {
                      select: {
                        customerType: true,
                        firstName: true,
                        lastName: true,
                        companyName: true,
                      },
                    },
                    unit: { select: { code: true } },
                  },
                },
              },
            },
          },
        }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'rent_increase_not_found',
        message: 'Tanda no encontrada',
      });
    }
    const items: RentIncreaseItemDto[] = row.items.map((it) => ({
      id: it.id,
      contractId: it.contractId,
      contractNumber: it.contract?.contractNumber ?? '',
      customerName: it.contract ? customerName(it.contract.customer) : '',
      unitCode: it.contract?.unit.code ?? '',
      oldPrice: Number(it.oldPrice),
      newPrice: Number(it.newPrice),
      status: it.status as RentIncreaseItemDto['status'],
      skipReason: it.skipReason,
      appliedAt: it.appliedAt?.toISOString() ?? null,
    }));
    return { ...this.toDto(row), items };
  }

  private async findRow(tenantId: string, id: string): Promise<RentIncreaseRow> {
    const row = await this.prisma.withTenant(
      (tx) => tx.rentIncrease.findFirst({ where: { id, tenantId } }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'rent_increase_not_found',
        message: 'Tanda no encontrada',
      });
    }
    return row;
  }

  private toDto(r: RentIncreaseRow): RentIncreaseDto {
    return {
      id: r.id,
      name: r.name,
      scope: (r.scope as RentIncreaseScopeInput) ?? { minMonthsSinceSigned: 0 },
      increaseType: r.increaseType as RentIncreaseDto['increaseType'],
      increaseValue: Number(r.increaseValue),
      effectiveDate: r.effectiveDate.toISOString().slice(0, 10),
      status: r.status as RentIncreaseDto['status'],
      affectedCount: r.affectedCount,
      appliedCount: r.appliedCount,
      mrrDelta: Number(r.mrrDelta),
      noticeSent: r.noticeSent,
      createdAt: r.createdAt.toISOString(),
      appliedAt: r.appliedAt?.toISOString() ?? null,
    };
  }
}
