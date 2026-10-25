import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  MoveFromUnitChangeSchema,
  ResolveUnitChangeRequestSchema,
  type UnitChangeRequestDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ContractsService } from '../contracts/contracts.service';

import { UnitChangesService } from './unit-changes.service';

import type { Request } from 'express';

class ResolveUnitChangeRequestDto extends createZodDto(ResolveUnitChangeRequestSchema) {}
class MoveFromUnitChangeDto extends createZodDto(MoveFromUnitChangeSchema) {}

@Controller('unit-change-requests')
export class UnitChangesController {
  constructor(
    private readonly service: UnitChangesService,
    private readonly contracts: ContractsService,
  ) {}

  @RequirePermission('contracts:read')
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('facilityId') facilityId?: string,
  ): Promise<UnitChangeRequestDto[]> {
    return this.service.list(user.tenantId, status, {
      ...(facilityId ? { facilityId } : {}),
      facilityScope: user.facilityScope ?? null,
    });
  }

  /** Nº de solicitudes pendientes — para el badge del menú. */
  @RequirePermission('contracts:read')
  @Get('pending-count')
  async pendingCount(@CurrentUser() user: AuthenticatedUser): Promise<{ count: number }> {
    return { count: await this.service.countPending(user.tenantId) };
  }

  @RequirePermission('contracts:write')
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  resolve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ResolveUnitChangeRequestDto,
  ): Promise<UnitChangeRequestDto> {
    return this.service.resolve({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      input: body,
      facilityScope: user.facilityScope ?? null,
    });
  }

  /** Traslada el contrato al trastero elegido y da la solicitud por gestionada. */
  @RequirePermission('contracts:manage')
  @Post(':id/move')
  @HttpCode(HttpStatus.OK)
  async move(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: MoveFromUnitChangeDto,
    @Req() req: Request,
  ): Promise<UnitChangeRequestDto> {
    const scope = user.facilityScope ?? null;
    const contractId = await this.service.pendingContractId(user.tenantId, id, scope);
    const ua = req.headers['user-agent'];
    const moved = await this.contracts.changeUnit({
      tenantId: user.tenantId,
      userId: user.sub,
      contractId,
      newUnitId: body.newUnitId,
      ...(body.newPrice !== undefined ? { newPrice: body.newPrice } : {}),
      ...(body.prorate !== undefined ? { prorate: body.prorate } : {}),
      facilityScope: scope,
      meta: {
        ...(typeof ua === 'string' ? { userAgent: ua } : {}),
        ...(req.ip ? { ipAddress: req.ip } : {}),
      },
    });
    return this.service.resolve({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      input: { status: 'handled', resolutionNote: `Trasladado al trastero ${moved.unitCode}` },
      facilityScope: scope,
    });
  }
}
