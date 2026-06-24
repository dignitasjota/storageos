import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import {
  CreateMaintenancePlanSchema,
  type MaintenancePlanDto,
  UpdateMaintenancePlanSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { MaintenanceService } from './maintenance.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateMaintenancePlanDto extends createZodDto(CreateMaintenancePlanSchema) {}
class UpdateMaintenancePlanDto extends createZodDto(UpdateMaintenancePlanSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('maintenance-plans')
export class MaintenanceController {
  constructor(private readonly service: MaintenanceService) {}

  @RequirePermission('tasks:read')
  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<MaintenancePlanDto[]> {
    return this.service.list(user.tenantId);
  }

  @RequirePermission('tasks:manage')
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateMaintenancePlanDto,
    @Req() req: Request,
  ): Promise<MaintenancePlanDto> {
    return this.service.create({
      tenantId: user.tenantId,
      userId: user.sub,
      input,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('tasks:manage')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateMaintenancePlanDto,
    @Req() req: Request,
  ): Promise<MaintenancePlanDto> {
    return this.service.update({
      tenantId: user.tenantId,
      userId: user.sub,
      planId: id,
      input,
      meta: extractMeta(req),
    });
  }

  /** Genera ahora la tarea del plan (si vencía), sin esperar al cron diario. */
  @RequirePermission('tasks:manage')
  @Post(':id/run')
  @HttpCode(HttpStatus.OK)
  async run(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ generated: boolean }> {
    const generated = await this.service.generateFromPlan(user.tenantId, id);
    return { generated };
  }

  @RequirePermission('tasks:manage')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.service.remove({
      tenantId: user.tenantId,
      userId: user.sub,
      planId: id,
      meta: extractMeta(req),
    });
  }
}
