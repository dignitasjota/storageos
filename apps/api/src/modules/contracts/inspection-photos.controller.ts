import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  type InspectionKindValue,
  type InspectionPhotoDto,
  type InspectionPhotoUploadDto,
  RegisterInspectionPhotoSchema,
  RequestInspectionPhotoUploadSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { InspectionPhotosService } from './inspection-photos.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class RequestInspectionPhotoUploadDto extends createZodDto(RequestInspectionPhotoUploadSchema) {}
class RegisterInspectionPhotoDto extends createZodDto(RegisterInspectionPhotoSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('contracts/:contractId/inspection-photos')
export class InspectionPhotosController {
  constructor(private readonly service: InspectionPhotosService) {}

  @RequirePermission('contracts:read')
  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contractId', new ParseUUIDPipe()) contractId: string,
    @Query('kind') kind?: InspectionKindValue,
  ): Promise<InspectionPhotoDto[]> {
    return this.service.list(user.tenantId, contractId, kind, user.facilityScope ?? null);
  }

  @RequirePermission('contracts:write')
  @Post('upload-url')
  async uploadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contractId', new ParseUUIDPipe()) contractId: string,
    @Body() input: RequestInspectionPhotoUploadDto,
  ): Promise<InspectionPhotoUploadDto> {
    return this.service.requestUploadUrl(
      user.tenantId,
      contractId,
      input,
      user.facilityScope ?? null,
    );
  }

  @RequirePermission('contracts:write')
  @Post()
  async register(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contractId', new ParseUUIDPipe()) contractId: string,
    @Body() input: RegisterInspectionPhotoDto,
    @Req() req: Request,
  ): Promise<InspectionPhotoDto> {
    return this.service.register({
      tenantId: user.tenantId,
      userId: user.sub,
      contractId,
      input,
      meta: extractMeta(req),
      scope: user.facilityScope ?? null,
    });
  }

  @RequirePermission('contracts:write')
  @Delete(':photoId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contractId', new ParseUUIDPipe()) contractId: string,
    @Param('photoId', new ParseUUIDPipe()) photoId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.service.delete({
      tenantId: user.tenantId,
      userId: user.sub,
      contractId,
      photoId,
      meta: extractMeta(req),
      scope: user.facilityScope ?? null,
    });
  }
}
