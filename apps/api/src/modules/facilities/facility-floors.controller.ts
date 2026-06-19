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

  @RequirePermission('facilities:read')
  @Get('facilities/:facilityId/floors')
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('facilityId', new ParseUUIDPipe()) facilityId: string,
  ): Promise<FacilityFloorDto[]> {
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
    const floor = await this.floors.findOrThrow(user.tenantId, floorId);
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
    return this.floors.updateUnitsLayout(user.tenantId, user.sub, id, input, extractMeta(req));
  }
}
