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
import { ResolveUnitChangeRequestSchema, type UnitChangeRequestDto } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { UnitChangesService } from './unit-changes.service';

class ResolveUnitChangeRequestDto extends createZodDto(ResolveUnitChangeRequestSchema) {}

@Controller('unit-change-requests')
export class UnitChangesController {
  constructor(private readonly service: UnitChangesService) {}

  @RequirePermission('contracts:read')
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
  ): Promise<UnitChangeRequestDto[]> {
    return this.service.list(user.tenantId, status);
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
    return this.service.resolve({ tenantId: user.tenantId, userId: user.sub, id, input: body });
  }
}
