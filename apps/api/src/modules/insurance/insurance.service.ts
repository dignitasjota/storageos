import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';

import type { Prisma } from '@storageos/database';
import type {
  CreateInsurancePlanInput,
  InsurancePlanDto,
  UpdateInsurancePlanInput,
} from '@storageos/shared';

type InsurancePlanRow = Prisma.InsurancePlanGetPayload<object>;

@Injectable()
export class InsuranceService {
  constructor(private readonly prisma: PrismaService) {}

  private toDto(p: InsurancePlanRow): InsurancePlanDto {
    return {
      id: p.id,
      name: p.name,
      monthlyPrice: Number(p.monthlyPrice),
      coverageAmount: Number(p.coverageAmount),
      taxRate: Number(p.taxRate),
      description: p.description,
      isActive: p.isActive,
      createdAt: p.createdAt.toISOString(),
    };
  }

  async list(tenantId: string, onlyActive = false): Promise<InsurancePlanDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.insurancePlan.findMany({
          where: { tenantId, ...(onlyActive ? { isActive: true } : {}) },
          orderBy: { createdAt: 'desc' },
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async create(tenantId: string, input: CreateInsurancePlanInput): Promise<InsurancePlanDto> {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.insurancePlan.create({
          data: {
            tenantId,
            name: input.name,
            monthlyPrice: input.monthlyPrice,
            coverageAmount: input.coverageAmount,
            taxRate: input.taxRate,
            description: input.description || null,
            isActive: input.isActive,
          },
        }),
      tenantId,
    );
    return this.toDto(row);
  }

  async update(
    tenantId: string,
    id: string,
    input: UpdateInsurancePlanInput,
  ): Promise<InsurancePlanDto> {
    await this.findOrThrow(tenantId, id);
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.insurancePlan.update({
          where: { id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.monthlyPrice !== undefined ? { monthlyPrice: input.monthlyPrice } : {}),
            ...(input.coverageAmount !== undefined ? { coverageAmount: input.coverageAmount } : {}),
            ...(input.taxRate !== undefined ? { taxRate: input.taxRate } : {}),
            ...(input.description !== undefined ? { description: input.description || null } : {}),
            ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          },
        }),
      tenantId,
    );
    return this.toDto(row);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await this.findOrThrow(tenantId, id);
    // ON DELETE SET NULL desvincula los contratos (conservan su insurance_price snapshot a null).
    await this.prisma.withTenant((tx) => tx.insurancePlan.delete({ where: { id } }), tenantId);
  }

  private async findOrThrow(tenantId: string, id: string): Promise<InsurancePlanRow> {
    const row = await this.prisma.withTenant(
      (tx) => tx.insurancePlan.findFirst({ where: { id, tenantId } }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'insurance_plan_not_found',
        message: 'Plan no encontrado',
      });
    }
    return row;
  }
}
