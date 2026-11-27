import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CreateSeoSiteChangeSchema,
  CreateSeoTaskSchema,
  MoveSeoTaskSchema,
  UpdateSeoSiteChangeSchema,
  UpdateSeoTaskSchema,
  isSeoDate,
  type SeoChartMarkerDto,
  type SeoSiteChangeDetailDto,
  type SeoSiteChangeDto,
  type SeoSiteChangeListDto,
  type SeoTaskDto,
  type SeoTaskListDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../../common/decorators/current-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import { RequireFeature } from '../../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { AdminAudit } from '../../admin/admin-audit.decorator';
import { AdminGuard } from '../../admin/admin.guard';
import { CurrentSuperAdmin } from '../../admin/current-super-admin.decorator';
import { RequireSuperadmin } from '../../admin/require-superadmin.decorator';
import { SeoProjectsService } from '../seo-projects.service';

import { SeoSiteChangesService, parseSeoSiteChangeQuery } from './seo-site-changes.service';
import { SeoTasksService, parseSeoTaskQuery } from './seo-tasks.service';

class CreateChangeDto extends createZodDto(CreateSeoSiteChangeSchema) {}
class UpdateChangeDto extends createZodDto(UpdateSeoSiteChangeSchema) {}
class CreateTaskDto extends createZodDto(CreateSeoTaskSchema) {}
class UpdateTaskDto extends createZodDto(UpdateSeoTaskSchema) {}
class MoveTaskDto extends createZodDto(MoveSeoTaskSchema) {}

/** Filtros de las marcas de los gráficos (fechas, dominio, búsqueda o URL). */
function markerQuery(q: Record<string, string | undefined>) {
  return {
    ...(q.domainId ? { domainId: q.domainId } : {}),
    ...(isSeoDate(q.from) ? { from: q.from } : {}),
    ...(isSeoDate(q.to) ? { to: q.to } : {}),
    ...(q.query?.trim() ? { query: q.query.trim().slice(0, 200) } : {}),
    ...(q.url?.trim() ? { url: q.url.trim().slice(0, 2000) } : {}),
  };
}

/**
 * El plan del proyecto del tenant: actuaciones (con su antes y después) y
 * tareas SEO. Ver con `analytics:read`; apuntar, cambiar y borrar con
 * `settings:manage` (el responsable de una tarea la mueve con `analytics:read`).
 * «Mis tareas» = `assignedTo=me`.
 */
@RequireFeature('seo_advanced')
@Controller('seo-advanced/plan')
export class SeoAdvancedPlanController {
  constructor(
    private readonly projects: SeoProjectsService,
    private readonly changes: SeoSiteChangesService,
    private readonly tasks: SeoTasksService,
  ) {}

  private projectId(user: AuthenticatedUser): Promise<string> {
    return this.projects.tenantProjectId(user.tenantId);
  }

  private taskQuery(user: AuthenticatedUser, q: Record<string, string | undefined>) {
    const parsed = parseSeoTaskQuery(q);
    return parsed.assignedTo === 'me' ? { ...parsed, assignedTo: user.sub } : parsed;
  }

  // ----------------------------------------------------------- actuaciones

  @RequirePermission('analytics:read')
  @Get('changes')
  async listChanges(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, string | undefined>,
  ): Promise<SeoSiteChangeListDto> {
    return this.changes.list(
      user.tenantId,
      await this.projectId(user),
      parseSeoSiteChangeQuery(query),
    );
  }

  @RequirePermission('analytics:read')
  @Get('changes/csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="actuaciones-seo.csv"')
  async changesCsv(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, string | undefined>,
  ): Promise<string> {
    return this.changes.csv(
      user.tenantId,
      await this.projectId(user),
      parseSeoSiteChangeQuery(query),
    );
  }

  @RequirePermission('analytics:read')
  @Get('changes/markers')
  async markers(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, string | undefined>,
  ): Promise<SeoChartMarkerDto[]> {
    return this.changes.markers(user.tenantId, await this.projectId(user), markerQuery(query));
  }

  @RequirePermission('analytics:read')
  @Get('changes/:changeId')
  async changeDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('changeId', ParseUUIDPipe) changeId: string,
  ): Promise<SeoSiteChangeDetailDto> {
    return this.changes.detail(user.tenantId, await this.projectId(user), changeId);
  }

  @RequirePermission('settings:manage')
  @Post('changes')
  async createChange(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateChangeDto,
  ): Promise<SeoSiteChangeDto> {
    return this.changes.create(user.tenantId, await this.projectId(user), body, {
      userId: user.sub,
    });
  }

  @RequirePermission('settings:manage')
  @Patch('changes/:changeId')
  async updateChange(
    @CurrentUser() user: AuthenticatedUser,
    @Param('changeId', ParseUUIDPipe) changeId: string,
    @Body() body: UpdateChangeDto,
  ): Promise<SeoSiteChangeDto> {
    return this.changes.update(user.tenantId, await this.projectId(user), changeId, body);
  }

  @RequirePermission('settings:manage')
  @Delete('changes/:changeId')
  @HttpCode(204)
  async removeChange(
    @CurrentUser() user: AuthenticatedUser,
    @Param('changeId', ParseUUIDPipe) changeId: string,
  ): Promise<void> {
    await this.changes.remove(user.tenantId, await this.projectId(user), changeId);
  }

  // ---------------------------------------------------------------- tareas

  @RequirePermission('analytics:read')
  @Get('tasks')
  async listTasks(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, string | undefined>,
  ): Promise<SeoTaskListDto> {
    return this.tasks.list(user.tenantId, await this.projectId(user), this.taskQuery(user, query));
  }

  @RequirePermission('analytics:read')
  @Get('tasks/csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="tareas-seo.csv"')
  async tasksCsv(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, string | undefined>,
  ): Promise<string> {
    return this.tasks.csv(user.tenantId, await this.projectId(user), this.taskQuery(user, query));
  }

  @RequirePermission('analytics:read')
  @Get('tasks/:taskId')
  async task(
    @CurrentUser() user: AuthenticatedUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
  ): Promise<SeoTaskDto> {
    return this.tasks.get(user.tenantId, await this.projectId(user), taskId);
  }

  @RequirePermission('settings:manage')
  @Post('tasks')
  async createTask(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateTaskDto,
  ): Promise<SeoTaskDto> {
    return this.tasks.create(user.tenantId, await this.projectId(user), body, {
      userId: user.sub,
    });
  }

  @RequirePermission('settings:manage')
  @Patch('tasks/:taskId')
  async updateTask(
    @CurrentUser() user: AuthenticatedUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() body: UpdateTaskDto,
  ): Promise<SeoTaskDto> {
    return this.tasks.update(user.tenantId, await this.projectId(user), taskId, body, {
      userId: user.sub,
    });
  }

  // Quien tiene la tarea asignada (o la creó) la mueve y la cierra con solo
  // `analytics:read`; el resto necesita `settings:manage`.
  @RequirePermission('analytics:read')
  @Post('tasks/:taskId/move')
  @HttpCode(200)
  async moveTask(
    @CurrentUser() user: AuthenticatedUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() body: MoveTaskDto,
  ): Promise<SeoTaskDto> {
    return this.tasks.move(user.tenantId, await this.projectId(user), taskId, body, {
      userId: user.sub,
      canManage: !!user.permissions?.includes('settings:manage'),
    });
  }

  @RequirePermission('settings:manage')
  @Delete('tasks/:taskId')
  @HttpCode(204)
  async removeTask(
    @CurrentUser() user: AuthenticatedUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
  ): Promise<void> {
    await this.tasks.remove(user.tenantId, await this.projectId(user), taskId);
  }
}

/**
 * El plan de un proyecto en el panel admin. Leer: cualquier super admin
 * (también los proyectos de los tenants); cambiar: el rol superadmin y solo en
 * los proyectos de la plataforma.
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/seo/projects/:id/plan')
export class AdminSeoPlanController {
  constructor(
    private readonly changes: SeoSiteChangesService,
    private readonly tasks: SeoTasksService,
  ) {}

  private taskQuery(superAdminId: string, q: Record<string, string | undefined>) {
    const parsed = parseSeoTaskQuery(q);
    return parsed.assignedTo === 'me' ? { ...parsed, assignedTo: superAdminId } : parsed;
  }

  @Get('changes')
  listChanges(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, string | undefined>,
  ): Promise<SeoSiteChangeListDto> {
    return this.changes.list(undefined, id, parseSeoSiteChangeQuery(query));
  }

  @Get('changes/csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="actuaciones-seo.csv"')
  changesCsv(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, string | undefined>,
  ): Promise<string> {
    return this.changes.csv(undefined, id, parseSeoSiteChangeQuery(query));
  }

  @Get('changes/markers')
  markers(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, string | undefined>,
  ): Promise<SeoChartMarkerDto[]> {
    return this.changes.markers(undefined, id, markerQuery(query));
  }

  @Get('changes/:changeId')
  changeDetail(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('changeId', ParseUUIDPipe) changeId: string,
  ): Promise<SeoSiteChangeDetailDto> {
    return this.changes.detail(undefined, id, changeId);
  }

  @Post('changes')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.change_created')
  createChange(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentSuperAdmin('sub') superAdminId: string,
    @Body() body: CreateChangeDto,
  ): Promise<SeoSiteChangeDto> {
    return this.changes.create(null, id, body, { superAdminId });
  }

  @Patch('changes/:changeId')
  @RequireSuperadmin()
  updateChange(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('changeId', ParseUUIDPipe) changeId: string,
    @Body() body: UpdateChangeDto,
  ): Promise<SeoSiteChangeDto> {
    return this.changes.update(null, id, changeId, body);
  }

  @Delete('changes/:changeId')
  @RequireSuperadmin()
  @HttpCode(204)
  async removeChange(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('changeId', ParseUUIDPipe) changeId: string,
  ): Promise<void> {
    await this.changes.remove(null, id, changeId);
  }

  @Get('tasks')
  listTasks(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentSuperAdmin('sub') superAdminId: string,
    @Query() query: Record<string, string | undefined>,
  ): Promise<SeoTaskListDto> {
    return this.tasks.list(undefined, id, this.taskQuery(superAdminId, query));
  }

  @Get('tasks/csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="tareas-seo.csv"')
  tasksCsv(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentSuperAdmin('sub') superAdminId: string,
    @Query() query: Record<string, string | undefined>,
  ): Promise<string> {
    return this.tasks.csv(undefined, id, this.taskQuery(superAdminId, query));
  }

  @Get('tasks/:taskId')
  task(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
  ): Promise<SeoTaskDto> {
    return this.tasks.get(undefined, id, taskId);
  }

  @Post('tasks')
  @RequireSuperadmin()
  createTask(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentSuperAdmin('sub') superAdminId: string,
    @Body() body: CreateTaskDto,
  ): Promise<SeoTaskDto> {
    return this.tasks.create(null, id, body, { superAdminId });
  }

  @Patch('tasks/:taskId')
  @RequireSuperadmin()
  updateTask(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @CurrentSuperAdmin('sub') superAdminId: string,
    @Body() body: UpdateTaskDto,
  ): Promise<SeoTaskDto> {
    return this.tasks.update(null, id, taskId, body, { superAdminId });
  }

  @Post('tasks/:taskId/move')
  @RequireSuperadmin()
  @HttpCode(200)
  moveTask(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() body: MoveTaskDto,
  ): Promise<SeoTaskDto> {
    return this.tasks.move(null, id, taskId, body);
  }

  @Delete('tasks/:taskId')
  @RequireSuperadmin()
  @HttpCode(204)
  async removeTask(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
  ): Promise<void> {
    await this.tasks.remove(null, id, taskId);
  }
}
