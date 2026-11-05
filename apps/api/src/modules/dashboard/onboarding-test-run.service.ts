import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { CancelContractSchema, CreateContractSchema } from '@storageos/shared';

import { todayInTimezone } from '../../common/format';
import { ContractsService } from '../contracts/contracts.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { SignaturesService } from '../move-in/signatures.service';

import { OnboardingService } from './onboarding.service';

import type { RequestMeta } from '../auth/auth.service';
import type { OnboardingTestRunDto } from '@storageos/shared';

/**
 * Inquilino de prueba: el tenant recorre con su propio email lo que vivirán sus
 * clientes (firma, acceso y área de clientes). No se le factura nada, para no
 * tocar la numeración ni Veri*Factu, y al borrarlo no deja rastro operativo.
 */
@Injectable()
export class OnboardingTestRunService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly contracts: ContractsService,
    private readonly signatures: SignaturesService,
    private readonly onboarding: OnboardingService,
  ) {}

  async start(tenantId: string, userId: string, meta: RequestMeta): Promise<OnboardingTestRunDto> {
    const existing = await this.admin.customer.count({
      where: { tenantId, isTest: true, deletedAt: null },
    });
    if (existing > 0) {
      throw new ConflictException({
        code: 'test_run_exists',
        message: 'Ya tienes un inquilino de prueba: bórralo antes de crear otro',
      });
    }
    const [user, unit] = await Promise.all([
      this.admin.user.findUniqueOrThrow({
        where: { id: userId },
        select: { email: true, fullName: true },
      }),
      this.admin.unit.findFirst({
        where: {
          tenantId,
          status: 'available',
          facility: { deletedAt: null, isActive: true, preOpening: false },
        },
        orderBy: { basePriceMonthly: 'asc' },
        select: { id: true, basePriceMonthly: true },
      }),
    ]);
    if (!unit) {
      throw new BadRequestException({
        code: 'no_unit_available',
        message: 'Necesitas un trastero libre para hacer la prueba',
      });
    }
    const customer = await this.prisma.withTenant(
      (tx) =>
        tx.customer.create({
          data: {
            tenantId,
            isTest: true,
            firstName: 'Prueba',
            lastName: user.fullName,
            email: user.email,
          },
          select: { id: true },
        }),
      tenantId,
    );
    const contract = await this.contracts.create({
      tenantId,
      userId,
      input: CreateContractSchema.parse({
        customerId: customer.id,
        unitId: unit.id,
        startDate: todayInTimezone().toISOString().slice(0, 10),
        priceMonthly: Number(unit.basePriceMonthly),
        depositAmount: 0,
      }),
      meta,
    });
    const { signingUrl } = await this.signatures.sendSigningLink(tenantId, contract.id, {
      bestEffortEmail: true,
    });
    await this.onboarding.patchState(tenantId, { testRunAt: new Date().toISOString() });
    return { customerId: customer.id, contractId: contract.id, signingUrl };
  }

  async remove(tenantId: string, userId: string, meta: RequestMeta): Promise<void> {
    const customers = await this.admin.customer.findMany({
      where: { tenantId, isTest: true, deletedAt: null },
      select: {
        id: true,
        contracts: {
          where: { deletedAt: null, status: { not: 'cancelled' } },
          select: { id: true },
        },
      },
    });
    const now = new Date();
    for (const customer of customers) {
      for (const { id } of customer.contracts) {
        await this.contracts.cancel({
          tenantId,
          userId,
          contractId: id,
          input: CancelContractSchema.parse({ reason: 'Inquilino de prueba' }),
          meta,
        });
      }
      await this.prisma.withTenant(async (tx) => {
        await tx.contract.updateMany({
          where: { customerId: customer.id },
          data: { deletedAt: now },
        });
        await tx.customer.update({ where: { id: customer.id }, data: { deletedAt: now } });
      }, tenantId);
    }
  }
}
