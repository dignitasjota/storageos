import {
  BadRequestException,
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
  AddOpsFileSchema,
  BulkAssignTasksSchema,
  type BulkAssignTasksResultDto,
  CreateTaskSchema,
  type TaskCommentDto,
  TaskCommentSchema,
  type TaskDto,
  TaskDueFilterEnum,
  type TaskDueFilter,
  type MessageAttachmentUploadDto,
  type MyTasksCountDto,
  OpsFileUploadSchema,
  TaskStatusEnum,
  type TaskStatusValue,
  TaskTypeEnum,
  type TaskTypeValue,
  TransitionTaskSchema,
  UpdateChecklistItemSchema,
  UpdateTaskSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { assertUuid, parsePageRequest, toPage } from '../../common/pagination';

import { TasksService } from './tasks.service';

import type { RequestMeta } from '../auth/auth.service';
import type { PageDto } from '@storageos/shared';
import type { Request } from 'express';

class CreateTaskDto extends createZodDto(CreateTaskSchema) {}
class BulkAssignTasksDto extends createZodDto(BulkAssignTasksSchema) {}
class UpdateTaskDto extends createZodDto(UpdateTaskSchema) {}
class TransitionTaskDto extends createZodDto(TransitionTaskSchema) {}
class UpdateChecklistItemDto extends createZodDto(UpdateChecklistItemSchema) {}
class TaskCommentDto2 extends createZodDto(TaskCommentSchema) {}
class OpsFileUploadDto extends createZodDto(OpsFileUploadSchema) {}
class AddOpsFileDto extends createZodDto(AddOpsFileSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

/** Filtros de la lista: un valor que no existe es un 400, no un error del servidor. */
function listFilters(q: {
  status?: string | undefined;
  type?: string | undefined;
  facilityId?: string | undefined;
  unitId?: string | undefined;
  assignedToUserId?: string | undefined;
  due?: string | undefined;
}): {
  status?: TaskStatusValue;
  type?: TaskTypeValue;
  facilityId?: string;
  unitId?: string;
  assignedToUserId?: string;
  due?: TaskDueFilter;
} {
  const status = q.status ? TaskStatusEnum.safeParse(q.status) : null;
  const type = q.type ? TaskTypeEnum.safeParse(q.type) : null;
  const due = q.due ? TaskDueFilterEnum.safeParse(q.due) : null;
  if ((status && !status.success) || (type && !type.success) || (due && !due.success)) {
    throw new BadRequestException({ code: 'invalid_filter', message: 'Filtro no válido' });
  }
  assertUuid(q.facilityId);
  assertUuid(q.unitId);
  assertUuid(q.assignedToUserId);
  return {
    ...(status?.success ? { status: status.data } : {}),
    ...(type?.success ? { type: type.data } : {}),
    ...(due?.success ? { due: due.data } : {}),
    ...(q.facilityId ? { facilityId: q.facilityId } : {}),
    ...(q.unitId ? { unitId: q.unitId } : {}),
    ...(q.assignedToUserId ? { assignedToUserId: q.assignedToUserId } : {}),
  };
}

@Controller('tasks')
export class TasksController {
  constructor(private readonly service: TasksService) {}

  /** Página de la lista (cursor + búsqueda) para el panel. Antes de `:id`. */
  @Get('page')
  @RequirePermission('tasks:read')
  async page(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('type') type?: string,
    @Query('facilityId') facilityId?: string,
    @Query('unitId') unitId?: string,
    @Query('assignedToUserId') assignedToUserId?: string,
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('due') due?: string,
  ): Promise<PageDto<TaskDto>> {
    const page = parsePageRequest(cursor, limit);
    const rows = await this.service.list(user.tenantId, {
      ...(search ? { search } : {}),
      page,
      ...listFilters({ status, type, facilityId, unitId, assignedToUserId, due }),
      facilityScope: user.facilityScope ?? null,
    });
    return toPage(rows, page);
  }

  @Get()
  @RequirePermission('tasks:read')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('type') type?: string,
    @Query('facilityId') facilityId?: string,
    @Query('unitId') unitId?: string,
    @Query('assignedToUserId') assignedToUserId?: string,
    @Query('due') due?: string,
  ): Promise<TaskDto[]> {
    return this.service.list(user.tenantId, {
      ...listFilters({ status, type, facilityId, unitId, assignedToUserId, due }),
      facilityScope: user.facilityScope ?? null,
    });
  }

  /** Mis tareas atrasadas o para hoy (el número del menú). Antes de `:id`. */
  @Get('mine-count')
  @RequirePermission('tasks:read')
  mineCount(@CurrentUser() user: AuthenticatedUser): Promise<MyTasksCountDto> {
    return this.service.myCount(user.tenantId, user.sub, user.facilityScope ?? null);
  }

  @Post(':id/photos/upload-url')
  @RequirePermission('tasks:write')
  @HttpCode(HttpStatus.OK)
  photoUploadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: OpsFileUploadDto,
  ): Promise<MessageAttachmentUploadDto> {
    return this.service.photoUploadUrl(
      user.tenantId,
      id,
      body.mimeType,
      user.facilityScope ?? null,
    );
  }

  @Post(':id/photos')
  @RequirePermission('tasks:write')
  addPhoto(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: AddOpsFileDto,
  ): Promise<TaskDto> {
    return this.service.addPhoto(user.tenantId, id, body, user.facilityScope ?? null);
  }

  @Delete(':id/photos/:fileId')
  @RequirePermission('tasks:write')
  removePhoto(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('fileId', new ParseUUIDPipe()) fileId: string,
  ): Promise<TaskDto> {
    return this.service.removePhoto(user.tenantId, id, fileId, user.facilityScope ?? null);
  }

  /** Asignar varias tareas a una persona (o quitar la asignación). */
  @Post('bulk-assign')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tasks:write')
  bulkAssign(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: BulkAssignTasksDto,
    @Req() req: Request,
  ): Promise<BulkAssignTasksResultDto> {
    return this.service.bulkAssign({
      tenantId: user.tenantId,
      userId: user.sub,
      taskIds: body.taskIds,
      assignedToUserId: body.assignedToUserId,
      facilityScope: user.facilityScope ?? null,
      meta: extractMeta(req),
    });
  }

  @Get(':id')
  @RequirePermission('tasks:read')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<TaskDto> {
    return this.service.detail(user.tenantId, id, user.facilityScope ?? null);
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
      facilityScope: user.facilityScope ?? null,
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
      facilityScope: user.facilityScope ?? null,
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
      facilityScope: user.facilityScope ?? null,
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
      facilityScope: user.facilityScope ?? null,
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
    return this.service.listComments(user.tenantId, id, user.facilityScope ?? null);
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
      facilityScope: user.facilityScope ?? null,
      taskId: id,
      input: body,
      meta: extractMeta(req),
    });
  }

  @Patch(':id/checklist/:itemId')
  @RequirePermission('tasks:write')
  updateChecklistItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() body: UpdateChecklistItemDto,
    @Req() req: Request,
  ): Promise<TaskDto> {
    return this.service.updateChecklistItem({
      tenantId: user.tenantId,
      userId: user.sub,
      facilityScope: user.facilityScope ?? null,
      taskId: id,
      itemId,
      input: body,
      meta: extractMeta(req),
    });
  }
}
