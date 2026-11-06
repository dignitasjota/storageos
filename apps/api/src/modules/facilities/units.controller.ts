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
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  BulkCreateUnitsSchema,
  type BulkCreateUnitsResultDto,
  type BulkUnitsActionInput,
  BulkUnitsActionSchema,
  type BulkUnitsResultDto,
  ChangeUnitStatusSchema,
  type FacilityImageUploadResponseDto,
  RequestFacilityImageUploadSchema,
  SaveUnitViewSchema,
  SetFacilityImagesSchema,
  type UnitInsightsDto,
  CreateUnitSchema,
  StackUnitsSchema,
  type UnitDto,
  type UnitSavedViewDto,
  type UnitsOverviewDto,
  type UnitStatusHistoryDto,
  UnitStatusEnum,
  UpdateUnitSchema,
} from '@storageos/shared';
import { createZodDto, ZodValidationPipe } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { assertFacilityAllowed } from '../../common/facility-scope';
import { userCan } from '../../common/guards/permissions.guard';
import { assertUuid } from '../../common/pagination';

import { UnitsInventoryService } from './units-inventory.service';
import { UnitsOverviewService } from './units-overview.service';
import { UnitsService } from './units.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateUnitDto extends createZodDto(CreateUnitSchema) {}
class UpdateUnitDto extends createZodDto(UpdateUnitSchema) {}
class ChangeUnitStatusDto extends createZodDto(ChangeUnitStatusSchema) {}
class StackUnitsDto extends createZodDto(StackUnitsSchema) {}
class BulkCreateUnitsDto extends createZodDto(BulkCreateUnitsSchema) {}
class SaveUnitViewDto extends createZodDto(SaveUnitViewSchema) {}
class RequestUnitImageUploadDto extends createZodDto(RequestFacilityImageUploadSchema) {}
class SetUnitImagesDto extends createZodDto(SetFacilityImagesSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('units')
export class UnitsController {
  constructor(
    private readonly units: UnitsService,
    private readonly inventory: UnitsInventoryService,
    private readonly overviewService: UnitsOverviewService,
  ) {}

  /** La lista: cada trastero con su inquilino, cuota, deuda, días libre y oferta. */
  @RequirePermission('units:read')
  @Get('overview')
  async overview(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
  ): Promise<UnitsOverviewDto> {
    assertUuid(facilityId);
    return this.overviewService.overview(user.tenantId, {
      ...(facilityId ? { facilityId } : {}),
      facilityScope: user.facilityScope ?? null,
      tenantsVisible: userCan(user, 'customers:read'),
      moneyVisible:
        userCan(user, 'customers:read') &&
        userCan(user, 'invoices:read') &&
        userCan(user, 'payments:read'),
    });
  }

  /** Vistas de la lista, compartidas por el equipo. */
  @RequirePermission('units:read')
  @Get('views')
  async views(@CurrentUser() user: AuthenticatedUser): Promise<UnitSavedViewDto[]> {
    return this.overviewService.listViews(user.tenantId);
  }

  @RequirePermission('units:write')
  @Post('views')
  async saveView(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: SaveUnitViewDto,
  ): Promise<UnitSavedViewDto> {
    return this.overviewService.saveView(user.tenantId, user.sub, input);
  }

  @RequirePermission('units:write')
  @Delete('views/:viewId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteView(
    @CurrentUser() user: AuthenticatedUser,
    @Param('viewId', new ParseUUIDPipe()) viewId: string,
  ): Promise<void> {
    await this.overviewService.deleteView(user.tenantId, viewId);
  }

  @RequirePermission('units:write')
  @Post(':id/images/upload-url')
  @HttpCode(HttpStatus.OK)
  async imageUploadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: RequestUnitImageUploadDto,
  ): Promise<FacilityImageUploadResponseDto> {
    return this.inventory.imageUploadUrl(user.tenantId, id, input, user.facilityScope ?? null);
  }

  @RequirePermission('units:write')
  @Put(':id/images')
  async setImages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: SetUnitImagesDto,
    @Req() req: Request,
  ): Promise<UnitDto> {
    return this.inventory.setImages({
      tenantId: user.tenantId,
      userId: user.sub,
      unitId: id,
      images: input.images,
      meta: extractMeta(req),
      facilityScope: user.facilityScope ?? null,
    });
  }

  /** Cambia estado, tipo, planta o precio de varios trasteros. */
  @RequirePermission('units:write')
  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  async bulk(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(BulkUnitsActionSchema)) input: BulkUnitsActionInput,
    @Req() req: Request,
  ): Promise<BulkUnitsResultDto> {
    return this.inventory.bulk({
      tenantId: user.tenantId,
      userId: user.sub,
      input,
      meta: extractMeta(req),
      facilityScope: user.facilityScope ?? null,
    });
  }

  /** Alta de varios trasteros seguidos con un patrón de código. */
  @RequirePermission('units:write')
  @Post('bulk-create')
  async bulkCreate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: BulkCreateUnitsDto,
    @Req() req: Request,
  ): Promise<BulkCreateUnitsResultDto> {
    return this.inventory.bulkCreate({
      tenantId: user.tenantId,
      userId: user.sub,
      input,
      meta: extractMeta(req),
      facilityScope: user.facilityScope ?? null,
    });
  }

  /** Historial de precios e inquilinos, días libre y lo facturado por el trastero. */
  @RequirePermission('units:read')
  @Get(':id/insights')
  async insights(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<UnitInsightsDto> {
    return this.inventory.insights(user.tenantId, id, user.facilityScope ?? null);
  }

  @RequirePermission('units:read')
  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
    @Query('floorId') floorId?: string,
    @Query('unitTypeId') unitTypeId?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<{ items: UnitDto[]; nextCursor: string | null }> {
    const parsedStatus = status ? UnitStatusEnum.parse(status) : undefined;
    for (const id of [facilityId, floorId, unitTypeId, cursor]) assertUuid(id);
    const parsedLimit = Number.parseInt(limit ?? '', 10);
    return this.units.list(user.tenantId, {
      ...(facilityId ? { facilityId } : {}),
      ...(floorId ? { floorId } : {}),
      ...(unitTypeId ? { unitTypeId } : {}),
      ...(parsedStatus ? { status: parsedStatus } : {}),
      ...(search ? { search, searchTenants: userCan(user, 'customers:read') } : {}),
      ...(cursor ? { cursor } : {}),
      ...(Number.isFinite(parsedLimit) ? { limit: parsedLimit } : {}),
      facilityScope: user.facilityScope ?? null,
    });
  }

  @RequirePermission('units:read')
  @Get(':id')
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<UnitDto> {
    return this.units.detail(user.tenantId, id, user.facilityScope ?? null);
  }

  @RequirePermission('units:read')
  @Get(':id/history')
  async history(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<UnitStatusHistoryDto[]> {
    return this.units.history(user.tenantId, id, user.facilityScope ?? null);
  }

  @RequirePermission('units:write')
  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateUnitDto,
    @Req() req: Request,
  ): Promise<UnitDto> {
    assertFacilityAllowed(user.facilityScope, input.facilityId);
    return this.units.create({
      tenantId: user.tenantId,
      userId: user.sub,
      input,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('units:write')
  @Patch(':id')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateUnitDto,
    @Req() req: Request,
  ): Promise<UnitDto> {
    return this.units.update({
      tenantId: user.tenantId,
      userId: user.sub,
      unitId: id,
      input,
      meta: extractMeta(req),
      facilityScope: user.facilityScope ?? null,
    });
  }

  @RequirePermission('units:write')
  @Post(':id/change-status')
  @HttpCode(HttpStatus.OK)
  async changeStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: ChangeUnitStatusDto,
    @Req() req: Request,
  ): Promise<UnitDto> {
    return this.units.changeStatus({
      tenantId: user.tenantId,
      userId: user.sub,
      unitId: id,
      input,
      meta: extractMeta(req),
      facilityScope: user.facilityScope ?? null,
      canCreateTasks: userCan(user, 'tasks:write'),
    });
  }

  @RequirePermission('units:write')
  @Post(':id/stack-with')
  @HttpCode(HttpStatus.OK)
  async stackWith(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: StackUnitsDto,
    @Req() req: Request,
  ): Promise<UnitDto[]> {
    return this.units.stackUnits({
      tenantId: user.tenantId,
      userId: user.sub,
      unitId: id,
      targetUnitId: input.targetUnitId,
      meta: extractMeta(req),
      facilityScope: user.facilityScope ?? null,
    });
  }

  @RequirePermission('units:write')
  @Post(':id/unstack')
  @HttpCode(HttpStatus.OK)
  async unstack(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<UnitDto[]> {
    return this.units.unstackUnit({
      tenantId: user.tenantId,
      userId: user.sub,
      unitId: id,
      meta: extractMeta(req),
      facilityScope: user.facilityScope ?? null,
    });
  }

  @RequirePermission('units:manage')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.units.delete({
      tenantId: user.tenantId,
      userId: user.sub,
      unitId: id,
      meta: extractMeta(req),
      facilityScope: user.facilityScope ?? null,
    });
  }
}
