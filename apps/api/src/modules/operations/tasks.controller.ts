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
  Query,
  Req,
} from '@nestjs/common';
import {
  CreateTaskSchema,
  type TaskCommentDto,
  TaskCommentSchema,
  type TaskDto,
  type TaskStatusValue,
  type TaskTypeValue,
  TransitionTaskSchema,
  UpdateTaskSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { TasksService } from './tasks.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateTaskDto extends createZodDto(CreateTaskSchema) {}
class UpdateTaskDto extends createZodDto(UpdateTaskSchema) {}
class TransitionTaskDto extends createZodDto(TransitionTaskSchema) {}
class TaskCommentDto2 extends createZodDto(TaskCommentSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('tasks')
export class TasksController {
  constructor(private readonly service: TasksService) {}

  @Get()
  @RequirePermission('tasks:read')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('type') type?: string,
    @Query('facilityId') facilityId?: string,
    @Query('unitId') unitId?: string,
    @Query('assignedToUserId') assignedToUserId?: string,
  ): Promise<TaskDto[]> {
    return this.service.list(user.tenantId, {
      ...(status ? { status: status as TaskStatusValue } : {}),
      ...(type ? { type: type as TaskTypeValue } : {}),
      ...(facilityId ? { facilityId } : {}),
      ...(unitId ? { unitId } : {}),
      ...(assignedToUserId ? { assignedToUserId } : {}),
    });
  }

  @Get(':id')
  @RequirePermission('tasks:read')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<TaskDto> {
    return this.service.detail(user.tenantId, id);
  }

  @Post()
  @RequirePermission('tasks:write')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateTaskDto,
    @Req() req: Request,
  ): Promise<TaskDto> {
    return this.service.create({
      tenantId: user.tenantId,
      userId: user.sub,
      input: body,
      meta: extractMeta(req),
    });
  }

  @Patch(':id')
  @RequirePermission('tasks:write')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateTaskDto,
    @Req() req: Request,
  ): Promise<TaskDto> {
    return this.service.update({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      input: body,
      meta: extractMeta(req),
    });
  }

  @Post(':id/transition')
  @RequirePermission('tasks:write')
  transition(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: TransitionTaskDto,
    @Req() req: Request,
  ): Promise<TaskDto> {
    return this.service.transition({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      input: body,
      meta: extractMeta(req),
    });
  }

  @Delete(':id')
  @RequirePermission('tasks:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.service.remove({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      meta: extractMeta(req),
    });
  }

  @Get(':id/comments')
  @RequirePermission('tasks:read')
  listComments(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<TaskCommentDto[]> {
    return this.service.listComments(user.tenantId, id);
  }

  @Post(':id/comments')
  @RequirePermission('tasks:write')
  addComment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: TaskCommentDto2,
    @Req() req: Request,
  ): Promise<TaskCommentDto> {
    return this.service.addComment({
      tenantId: user.tenantId,
      userId: user.sub,
      taskId: id,
      input: body,
      meta: extractMeta(req),
    });
  }
}
