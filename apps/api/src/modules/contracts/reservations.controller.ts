import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  CancelReservationSchema,
  type ContractDto,
  ConvertReservationSchema,
  CreateReservationSchema,
  type ReservationDto,
  ReservationStatusEnum,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { ReservationsService } from './reservations.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateReservationDto extends createZodDto(CreateReservationSchema) {}
class CancelReservationDto extends createZodDto(CancelReservationSchema) {}
class ConvertReservationDto extends createZodDto(ConvertReservationSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @RequirePermission('reservations:read')
  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('unitId') unitId?: string,
    @Query('customerId') customerId?: string,
    @Query('status') status?: string,
    @Query('facilityId') facilityId?: string,
  ): Promise<ReservationDto[]> {
    const parsedStatus = status ? ReservationStatusEnum.parse(status) : undefined;
    return this.reservations.list(user.tenantId, {
      ...(unitId ? { unitId } : {}),
      ...(customerId ? { customerId } : {}),
      ...(parsedStatus ? { status: parsedStatus } : {}),
      ...(facilityId ? { facilityId } : {}),
    });
  }

  @RequirePermission('reservations:read')
  @Get(':id')
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ReservationDto> {
    return this.reservations.detail(user.tenantId, id);
  }

  @RequirePermission('reservations:write')
  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateReservationDto,
    @Req() req: Request,
  ): Promise<ReservationDto> {
    return this.reservations.create({
      tenantId: user.tenantId,
      userId: user.sub,
      input,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('reservations:write')
  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  async confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<ReservationDto> {
    return this.reservations.confirm({
      tenantId: user.tenantId,
      userId: user.sub,
      reservationId: id,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('reservations:write')
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: CancelReservationDto,
    @Req() req: Request,
  ): Promise<ReservationDto> {
    return this.reservations.cancel({
      tenantId: user.tenantId,
      userId: user.sub,
      reservationId: id,
      input,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('contracts:write')
  @Post(':id/convert-to-contract')
  @HttpCode(HttpStatus.OK)
  async convert(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: ConvertReservationDto,
    @Req() req: Request,
  ): Promise<ContractDto> {
    return this.reservations.convertToContract({
      tenantId: user.tenantId,
      userId: user.sub,
      reservationId: id,
      input,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('reservations:write')
  @Post('expire-due')
  @HttpCode(HttpStatus.OK)
  async expireDue(@CurrentUser() user: AuthenticatedUser): Promise<{ expired: number }> {
    return this.reservations.expireDue(user.tenantId);
  }
}
