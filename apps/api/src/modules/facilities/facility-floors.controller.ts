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
  CreateFloorSchema,
  type FacilityFloorDto,
  type PlanUploadResponseDto,
  RequestPlanUploadSchema,
  UpdateFloorPlanSchema,
  UpdateFloorSchema,
  UpdateUnitsLayoutSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { assertFacilityAllowed } from '../../common/facility-scope';
import { FilesService } from '../files/files.service';

import { FacilityFloorsService } from './facility-floors.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateFloorDto extends createZodDto(CreateFloorSchema) {}
class UpdateFloorDto extends createZodDto(UpdateFloorSchema) {}
class UpdateFloorPlanDto extends createZodDto(UpdateFloorPlanSchema) {}
class UpdateUnitsLayoutDto extends createZodDto(UpdateUnitsLayoutSchema) {}
class RequestPlanUploadDto extends createZodDto(RequestPlanUploadSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller()
export class FacilityFloorsController {
  constructor(
    private readonly floors: FacilityFloorsService,
    private readonly files: FilesService,
  ) {}

  /** La planta existe y es de un local que el usuario ve. */
  private async scopedFloor(user: AuthenticatedUser, floorId: string) {
    const floor = await this.floors.findOrThrow(user.tenantId, floorId);
    assertFacilityAllowed(user.facilityScope, floor.facilityId);
    return floor;
  }

  @RequirePermission('facilities:read')
  @Get('facilities/:facilityId/floors')
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('facilityId', new ParseUUIDPipe()) facilityId: string,
  ): Promise<FacilityFloorDto[]> {
    assertFacilityAllowed(user.facilityScope, facilityId);
    return this.floors.list(user.tenantId, facilityId);
  }

  @RequirePermission('facilities:manage')
  @Post('facilities/:facilityId/floors')
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('facilityId', new ParseUUIDPipe()) facilityId: string,
    @Body() input: CreateFloorDto,
    @Req() req: Request,
  ): Promise<FacilityFloorDto> {
    assertFacilityAllowed(user.facilityScope, facilityId);
    return this.floors.create(user.tenantId, user.sub, facilityId, input, extractMeta(req));
  }

  @RequirePermission('facilities:manage')
  @Patch('floors/:id')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateFloorDto,
    @Req() req: Request,
  ): Promise<FacilityFloorDto> {
    await this.scopedFloor(user, id);
    return this.floors.update(user.tenantId, user.sub, id, input, extractMeta(req));
  }

  @RequirePermission('facilities:manage')
  @Delete('floors/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.scopedFloor(user, id);
    await this.floors.delete(user.tenantId, user.sub, id, extractMeta(req));
  }

  @RequirePermission('facilities:manage')
  @Post('floors/:id/plan-upload-url')
  @HttpCode(HttpStatus.OK)
  async requestPlanUploadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) floorId: string,
    @Body() input: RequestPlanUploadDto,
  ): Promise<PlanUploadResponseDto> {
    const floor = await this.scopedFloor(user, floorId);
    const key = this.files.buildFloorPlanKey(
      user.tenantId,
      floor.facilityId,
      floorId,
      input.mimeType,
    );
    const { uploadUrl, expiresIn } = await this.files.getPresignedPutUrl({
      bucket: 'plans',
      key,
      contentType: input.mimeType,
      contentLengthRange: { min: 1, max: input.sizeBytes },
    });
    const publicUrl = this.files.buildPublicUrl('plans', key);
    return {
      uploadUrl,
      publicUrl,
      expiresIn,
      requiredHeaders: { 'Content-Type': input.mimeType },
    };
  }

  @RequirePermission('facilities:manage')
  @Patch('floors/:id/plan')
  async setPlan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateFloorPlanDto,
    @Req() req: Request,
  ): Promise<FacilityFloorDto> {
    await this.scopedFloor(user, id);
    return this.floors.setPlan(user.tenantId, user.sub, id, input, extractMeta(req));
  }

  @RequirePermission('facilities:manage')
  @Patch('floors/:id/units-layout')
  @HttpCode(HttpStatus.OK)
  async updateLayout(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateUnitsLayoutDto,
    @Req() req: Request,
  ): Promise<{ updated: number }> {
    await this.scopedFloor(user, id);
    return this.floors.updateUnitsLayout(user.tenantId, user.sub, id, input, extractMeta(req));
  }
}
