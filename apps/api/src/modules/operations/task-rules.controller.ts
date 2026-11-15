import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import { TaskAutoRulesSchema, type TaskAutoRules } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { assertAllFacilities } from '../../common/facility-scope';

import { TaskRulesService } from './task-rules.service';

import type { Request } from 'express';

class TaskAutoRulesDto extends createZodDto(TaskAutoRulesSchema) {}

/** Reglas de tareas automáticas. Registrado antes que `TasksController` (ruta `:id`). */
@Controller('tasks/auto-rules')
export class TaskRulesController {
  constructor(private readonly service: TaskRulesService) {}

  @RequirePermission('tasks:read')
  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<TaskAutoRules> {
    return this.service.get(user.tenantId);
  }

  @RequirePermission('tasks:manage')
  @Put()
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: TaskAutoRulesDto,
    @Req() req: Request,
  ): Promise<TaskAutoRules> {
    // Son de toda la empresa: solo quien ve todos los locales.
    assertAllFacilities(user.facilityScope);
    const ua = req.headers['user-agent'];
    return this.service.update({
      tenantId: user.tenantId,
      userId: user.sub,
      input: body,
      meta: {
        ...(typeof ua === 'string' ? { userAgent: ua } : {}),
        ...(req.ip ? { ipAddress: req.ip } : {}),
      },
    });
  }
}
