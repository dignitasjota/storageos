import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import {
  type ExpenseDto,
  type IncidentRepairTaskDto,
  OpsExpenseSchema,
  OpsTaskSchema,
  ReplyIncidentSchema,
  type TaskDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { DailyOpsService } from './daily-ops.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class OpsExpenseDto extends createZodDto(OpsExpenseSchema) {}
class OpsTaskDto extends createZodDto(OpsTaskSchema) {}
class ReplyIncidentDto extends createZodDto(ReplyIncidentSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(req.ip ? { ipAddress: req.ip } : {}),
  };
}

/** Tareas e incidencias que cruzan con Gastos y Mensajes. */
@Controller()
export class DailyOpsController {
  constructor(private readonly service: DailyOpsService) {}

  @RequirePermission('expenses:manage')
  @Post('tasks/:id/expense')
  taskExpense(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: OpsExpenseDto,
  ): Promise<ExpenseDto> {
    return this.service.taskExpense(user.tenantId, user.sub, id, body, user.facilityScope ?? null);
  }

  @RequirePermission('expenses:manage')
  @Post('incidents/:id/expense')
  incidentExpense(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: OpsExpenseDto,
  ): Promise<ExpenseDto> {
    return this.service.incidentExpense(
      user.tenantId,
      user.sub,
      id,
      body,
      user.facilityScope ?? null,
    );
  }

  @RequirePermission('incidents:write')
  @Post('incidents/:id/reply')
  @HttpCode(HttpStatus.NO_CONTENT)
  async reply(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ReplyIncidentDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.service.replyToCustomer(
      user.tenantId,
      user.sub,
      id,
      body,
      extractMeta(req),
      user.facilityScope ?? null,
    );
  }

  @RequirePermission('tasks:write')
  @Post('incidents/:id/task')
  incidentTask(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: OpsTaskDto,
    @Req() req: Request,
  ): Promise<TaskDto> {
    return this.service.incidentTask(
      user.tenantId,
      user.sub,
      id,
      body,
      extractMeta(req),
      user.facilityScope ?? null,
    );
  }

  @RequirePermission('incidents:read')
  @Get('incidents/:id/tasks')
  incidentTasks(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<IncidentRepairTaskDto[]> {
    return this.service.incidentTasks(user.tenantId, id, user.facilityScope ?? null);
  }

  @RequireFeature('business_reminders')
  @RequirePermission('tasks:write')
  @Post('business-reminders/:id/task')
  reminderTask(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: OpsTaskDto,
    @Req() req: Request,
  ): Promise<TaskDto> {
    return this.service.reminderTask(
      user.tenantId,
      user.sub,
      id,
      body,
      extractMeta(req),
      user.facilityScope ?? null,
    );
  }
}
