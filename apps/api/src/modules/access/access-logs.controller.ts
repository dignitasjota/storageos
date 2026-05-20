import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  type AccessLogDto,
  type AccessMethodValue,
  AccessResultEnum,
  type AccessResultValue,
} from '@storageos/shared';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../database/prisma.service';

import type { AccessDevice, AccessLog, Customer, CustomerType, Prisma } from '@storageos/database';

function customerDisplay(
  c: Pick<Customer, 'customerType' | 'firstName' | 'lastName' | 'companyName'> | null | undefined,
): string | null {
  if (!c) return null;
  if (c.customerType === ('business' as CustomerType)) return c.companyName ?? 'Empresa sin nombre';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Sin nombre';
}

type AccessLogWithIncludes = AccessLog & {
  device?: Pick<AccessDevice, 'name'> | null;
  customer?: Pick<Customer, 'customerType' | 'firstName' | 'lastName' | 'companyName'> | null;
};

function toDto(l: AccessLogWithIncludes): AccessLogDto {
  return {
    id: l.id,
    deviceId: l.deviceId,
    deviceName: l.device?.name ?? null,
    credentialId: l.credentialId,
    customerId: l.customerId,
    customerName: customerDisplay(l.customer),
    method: l.method as AccessMethodValue,
    result: l.result as AccessResultValue,
    attemptedValue: l.attemptedValue,
    reason: l.reason,
    ipAddress: l.ipAddress,
    metadata: (l.metadata ?? {}) as Record<string, unknown>,
    occurredAt: l.occurredAt.toISOString(),
  };
}

function parseResult(value: string | undefined): AccessResultValue | undefined {
  if (!value) return undefined;
  const parsed = AccessResultEnum.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const INCLUDE = {
  device: { select: { name: true } },
  customer: {
    select: {
      customerType: true,
      firstName: true,
      lastName: true,
      companyName: true,
    },
  },
} satisfies Prisma.AccessLogInclude;

@Controller('access/logs')
export class AccessLogsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('customerId') customerId?: string,
    @Query('deviceId') deviceId?: string,
    @Query('result') result?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<AccessLogDto[]> {
    const where: Prisma.AccessLogWhereInput = {};
    if (customerId) where.customerId = customerId;
    if (deviceId) where.deviceId = deviceId;
    const parsedResult = parseResult(result);
    if (parsedResult) where.result = parsedResult;
    if (from || to) {
      where.occurredAt = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {}),
      };
    }
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.accessLog.findMany({
          where,
          include: INCLUDE,
          orderBy: { occurredAt: 'desc' },
          take: 500,
        }),
      user.tenantId,
    );
    return rows.map((r) => toDto(r as AccessLogWithIncludes));
  }

  @Get(':id')
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AccessLogDto> {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.accessLog.findFirst({
          where: { id },
          include: INCLUDE,
        }),
      user.tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'access_log_not_found',
        message: 'Registro de acceso no encontrado',
      });
    }
    return toDto(row as AccessLogWithIncludes);
  }
}
