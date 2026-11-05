import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import {
  AssignUnitInboxSchema,
  type ReservationStatsDto,
  type UnitInboxDto,
  UnitInboxKindEnum,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { UnitInboxService } from './unit-inbox.service';

class AssignUnitInboxDto extends createZodDto(AssignUnitInboxSchema) {}

/** Bandeja única de peticiones de trastero. */
@Controller('unit-inbox')
export class UnitInboxController {
  constructor(private readonly inbox: UnitInboxService) {}

  @RequirePermission('reservations:read')
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
  ): Promise<UnitInboxDto> {
    return this.inbox.list(user.tenantId, {
      ...(facilityId ? { facilityId } : {}),
      facilityScope: user.facilityScope ?? null,
      includeRequests: user.permissions?.includes('contracts:read') ?? false,
    });
  }

  @RequirePermission('reservations:read')
  @Get('stats')
  stats(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') days?: string,
    @Query('facilityId') facilityId?: string,
  ): Promise<ReservationStatsDto> {
    const n = Number(days);
    return this.inbox.stats(user.tenantId, {
      days: Number.isInteger(n) && n > 0 && n <= 730 ? n : 90,
      ...(facilityId ? { facilityId } : {}),
      facilityScope: user.facilityScope ?? null,
    });
  }

  @RequirePermission('reservations:write')
  @Patch(':kind/:id/assign')
  @HttpCode(HttpStatus.NO_CONTENT)
  assign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('kind') kind: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: AssignUnitInboxDto,
  ): Promise<void> {
    return this.inbox.assign(user.tenantId, UnitInboxKindEnum.parse(kind), id, body.userId);
  }
}
