import { Body, Controller, Get, NotFoundException, Post, Query, Req } from '@nestjs/common';
import { type DoorViewDto, VisitorPinSchema, type VisitorPinDto } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { assertFacilityAllowed } from '../../common/facility-scope';
import { todayInTimezone } from '../../common/format';
import { PrismaService } from '../database/prisma.service';

import { AccessCredentialsService } from './access-credentials.service';

import type { Request } from 'express';

class VisitorPinBodyDto extends createZodDto(VisitorPinSchema) {}

function personName(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

const CUSTOMER = {
  select: { customerType: true, firstName: true, lastName: true, companyName: true },
} as const;

/**
 * Vista de la puerta para la tablet del local: quién entra y quién sale hoy,
 * los últimos accesos, abrir la puerta (con `POST /access/devices/:id/open`) y
 * un PIN de un solo uso para una visita.
 */
@Controller('access/door')
@RequireFeature('access_control')
export class AccessDoorController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: AccessCredentialsService,
  ) {}

  @RequirePermission('access:read')
  @Get()
  async view(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId: string,
  ): Promise<DoorViewDto> {
    const facility = await this.prisma.withTenant(
      (tx) =>
        tx.facility.findFirst({
          where: { id: facilityId, deletedAt: null },
          select: { id: true, name: true, timezone: true },
        }),
      user.tenantId,
    );
    if (!facility) {
      throw new NotFoundException({ code: 'facility_not_found', message: 'Local no encontrado' });
    }
    assertFacilityAllowed(user.facilityScope ?? null, facility.id);
    const today = todayInTimezone(facility.timezone);
    return this.prisma.withTenant(async (tx) => {
      const [devices, ins, outs, recent] = await Promise.all([
        tx.accessDevice.findMany({
          where: { facilityId: facility.id, isActive: true },
          select: { id: true, name: true, lastSeenAt: true },
          orderBy: { name: 'asc' },
        }),
        tx.contract.findMany({
          where: {
            deletedAt: null,
            status: { in: ['draft', 'active', 'ending'] },
            startDate: today,
            unit: { facilityId: facility.id },
          },
          select: {
            id: true,
            contractNumber: true,
            customerId: true,
            customer: CUSTOMER,
            unit: { select: { code: true } },
          },
        }),
        tx.contract.findMany({
          where: {
            deletedAt: null,
            status: { in: ['active', 'ending', 'ended'] },
            endDate: today,
            unit: { facilityId: facility.id },
          },
          select: {
            id: true,
            contractNumber: true,
            customerId: true,
            customer: CUSTOMER,
            unit: { select: { code: true } },
          },
        }),
        tx.accessLog.findMany({
          where: { device: { facilityId: facility.id } },
          orderBy: { occurredAt: 'desc' },
          take: 15,
          select: {
            id: true,
            occurredAt: true,
            result: true,
            customer: CUSTOMER,
            device: { select: { name: true } },
          },
        }),
      ]);
      const person = (c: (typeof ins)[number]) => ({
        contractId: c.id,
        contractNumber: c.contractNumber,
        customerId: c.customerId,
        customerName: personName(c.customer),
        unitCode: c.unit.code,
      });
      return {
        facility,
        devices: devices.map((d) => ({
          id: d.id,
          name: d.name,
          lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
        })),
        moveIns: ins.map(person),
        moveOuts: outs.map(person),
        recent: recent.map((l) => ({
          id: l.id,
          occurredAt: l.occurredAt.toISOString(),
          result: l.result,
          customerName: l.customer ? personName(l.customer) : null,
          deviceName: l.device?.name ?? null,
        })),
      };
    }, user.tenantId);
  }

  @RequirePermission('access:manage')
  @Post('visitor-pin')
  async visitorPin(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: VisitorPinBodyDto,
    @Req() req: Request,
  ): Promise<VisitorPinDto> {
    assertFacilityAllowed(user.facilityScope ?? null, body.facilityId);
    const ua = req.headers['user-agent'];
    return this.credentials.createVisitorPin({
      tenantId: user.tenantId,
      userId: user.sub,
      customerId: body.customerId,
      facilityId: body.facilityId,
      ...(body.label ? { label: body.label } : {}),
      facilityScope: user.facilityScope ?? null,
      meta: {
        ...(typeof ua === 'string' ? { userAgent: ua } : {}),
        ...(req.ip ? { ipAddress: req.ip } : {}),
      },
    });
  }
}
