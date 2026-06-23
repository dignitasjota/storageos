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
  Req,
} from '@nestjs/common';
import {
  type CheckoutPhotoDto,
  type CheckoutPhotoUploadDto,
  RegisterCheckoutPhotoSchema,
  RequestCheckoutPhotoUploadSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CheckoutPhotosService } from './checkout-photos.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class RequestCheckoutPhotoUploadDto extends createZodDto(RequestCheckoutPhotoUploadSchema) {}
class RegisterCheckoutPhotoDto extends createZodDto(RegisterCheckoutPhotoSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('contracts/:contractId/checkout-photos')
export class CheckoutPhotosController {
  constructor(private readonly service: CheckoutPhotosService) {}

  @RequirePermission('contracts:read')
  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contractId', new ParseUUIDPipe()) contractId: string,
  ): Promise<CheckoutPhotoDto[]> {
    return this.service.list(user.tenantId, contractId, user.facilityScope ?? null);
  }

  @RequirePermission('contracts:write')
  @Post('upload-url')
  async uploadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contractId', new ParseUUIDPipe()) contractId: string,
    @Body() input: RequestCheckoutPhotoUploadDto,
  ): Promise<CheckoutPhotoUploadDto> {
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
    @Body() input: RegisterCheckoutPhotoDto,
    @Req() req: Request,
  ): Promise<CheckoutPhotoDto> {
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
