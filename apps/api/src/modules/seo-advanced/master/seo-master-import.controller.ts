import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  SEO_MASTER_MAX_BYTES,
  type SeoKeywordGroupDto,
  type SeoMasterImportDetailDto,
  type SeoMasterImportDto,
  type SeoMasterPreviewDto,
  type SeoMasterRemoveResultDto,
} from '@storageos/shared';
import { memoryStorage } from 'multer';

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
import { type SeoUploadedFile } from '../seo-imports.service';
import { SeoProjectsService } from '../seo-projects.service';

import { SeoMasterImportService } from './seo-master-import.service';

const UPLOAD = FileInterceptor('file', {
  storage: memoryStorage(),
  limits: { fileSize: SEO_MASTER_MAX_BYTES, files: 1 },
});

/**
 * Los maestros de SEO del proyecto del tenant. Ver con `analytics:read`;
 * importar y borrar con `settings:manage` (como la importación de Search
 * Console).
 */
@RequireFeature('seo_advanced')
@Controller('seo-advanced')
export class SeoAdvancedMasterImportController {
  constructor(
    private readonly projects: SeoProjectsService,
    private readonly masters: SeoMasterImportService,
  ) {}

  private projectId(user: AuthenticatedUser): Promise<string> {
    return this.projects.tenantProjectId(user.tenantId);
  }

  @RequirePermission('analytics:read')
  @Get('master-imports')
  async list(@CurrentUser() user: AuthenticatedUser): Promise<SeoMasterImportDto[]> {
    return this.masters.list(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('analytics:read')
  @Get('master-imports/:importId')
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('importId', ParseUUIDPipe) importId: string,
  ): Promise<SeoMasterImportDetailDto> {
    return this.masters.detail(user.tenantId, await this.projectId(user), importId);
  }

  @RequirePermission('analytics:read')
  @Get('keyword-groups')
  async groups(@CurrentUser() user: AuthenticatedUser): Promise<SeoKeywordGroupDto[]> {
    return this.masters.groups(user.tenantId, await this.projectId(user));
  }

  /** Lo que haría la importación (no guarda nada). */
  @RequirePermission('settings:manage')
  @Post('master-imports/preview')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(UPLOAD)
  async preview(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: SeoUploadedFile | undefined,
  ): Promise<SeoMasterPreviewDto> {
    return this.masters.preview(user.tenantId, await this.projectId(user), file);
  }

  @RequirePermission('settings:manage')
  @Post('master-imports')
  @UseInterceptors(UPLOAD)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: SeoUploadedFile | undefined,
  ): Promise<SeoMasterImportDto> {
    return this.masters.create(user.tenantId, await this.projectId(user), file, {
      userId: user.sub,
    });
  }

  @RequirePermission('settings:manage')
  @Delete('master-imports/:importId')
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('importId', ParseUUIDPipe) importId: string,
  ): Promise<SeoMasterRemoveResultDto> {
    return this.masters.remove(user.tenantId, await this.projectId(user), importId);
  }
}

/**
 * Los maestros de un proyecto en el panel admin. Leer: cualquier super admin
 * (también los de los tenants); importar y borrar: el rol superadmin y solo en
 * los proyectos de la plataforma (los de los tenants, en lectura).
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/seo/projects/:id')
export class AdminSeoMasterImportController {
  constructor(private readonly masters: SeoMasterImportService) {}

  @Get('master-imports')
  list(@Param('id', ParseUUIDPipe) id: string): Promise<SeoMasterImportDto[]> {
    return this.masters.list(undefined, id);
  }

  @Get('master-imports/:importId')
  detail(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('importId', ParseUUIDPipe) importId: string,
  ): Promise<SeoMasterImportDetailDto> {
    return this.masters.detail(undefined, id, importId);
  }

  @Get('keyword-groups')
  groups(@Param('id', ParseUUIDPipe) id: string): Promise<SeoKeywordGroupDto[]> {
    return this.masters.groups(undefined, id);
  }

  @Post('master-imports/preview')
  @RequireSuperadmin()
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(UPLOAD)
  preview(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: SeoUploadedFile | undefined,
  ): Promise<SeoMasterPreviewDto> {
    return this.masters.preview(null, id, file);
  }

  @Post('master-imports')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.master_import_created')
  @UseInterceptors(UPLOAD)
  create(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: SeoUploadedFile | undefined,
    @CurrentSuperAdmin('sub') superAdminId: string,
  ): Promise<SeoMasterImportDto> {
    return this.masters.create(null, id, file, { superAdminId });
  }

  @Delete('master-imports/:importId')
  @RequireSuperadmin()
  @AdminAudit('admin.seo.master_import_deleted')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('importId', ParseUUIDPipe) importId: string,
  ): Promise<SeoMasterRemoveResultDto> {
    return this.masters.remove(null, id, importId);
  }
}
