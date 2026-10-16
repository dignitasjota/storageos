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
} from '@nestjs/common';
import {
  type BlogCoverUploadResponseDto,
  CreatePromoLandingSchema,
  type PromoLandingDto,
  type PromoLandingStatsDto,
  RequestBlogCoverUploadSchema,
  SetPromoLandingImageSchema,
  UpdatePromoLandingSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { PromoLandingsService } from './promo-landings.service';

class CreatePromoLandingDto extends createZodDto(CreatePromoLandingSchema) {}
class UpdatePromoLandingDto extends createZodDto(UpdatePromoLandingSchema) {}
class RequestPromoImageUploadDto extends createZodDto(RequestBlogCoverUploadSchema) {}
class SetPromoLandingImageDto extends createZodDto(SetPromoLandingImageSchema) {}

/** Landings de promoción de la web del tenant (lado staff). Feature `web_premium`. */
@RequireFeature('web_premium')
@Controller('promo-landings')
export class PromoLandingsController {
  constructor(private readonly promos: PromoLandingsService) {}

  @RequirePermission('settings:read')
  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<PromoLandingDto[]> {
    return this.promos.list(user.tenantId);
  }

  @RequirePermission('settings:read')
  @Get(':id/stats')
  stats(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('days') days?: string,
  ): Promise<PromoLandingStatsDto> {
    const n = Number(days ?? 30);
    return this.promos.stats(
      user.tenantId,
      id,
      Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 0), 3650) : 30,
    );
  }

  @RequirePermission('settings:read')
  @Get(':id')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<PromoLandingDto> {
    return this.promos.detail(user.tenantId, id);
  }

  @RequirePermission('settings:manage')
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreatePromoLandingDto,
  ): Promise<PromoLandingDto> {
    return this.promos.create(user.tenantId, body);
  }

  @RequirePermission('settings:manage')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdatePromoLandingDto,
  ): Promise<PromoLandingDto> {
    return this.promos.update(user.tenantId, id, body);
  }

  @RequirePermission('settings:manage')
  @Post(':id/duplicate')
  duplicate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<PromoLandingDto> {
    return this.promos.duplicate(user.tenantId, id);
  }

  @RequirePermission('settings:manage')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.promos.remove(user.tenantId, id);
  }

  @RequirePermission('settings:manage')
  @Post(':id/image/upload-url')
  @HttpCode(HttpStatus.OK)
  async requestImageUploadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: RequestPromoImageUploadDto,
  ): Promise<BlogCoverUploadResponseDto> {
    const { uploadUrl, key, expiresIn } = await this.promos.requestImageUploadUrl({
      tenantId: user.tenantId,
      id,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
    });
    return { uploadUrl, key, expiresIn, requiredHeaders: { 'Content-Type': input.mimeType } };
  }

  @RequirePermission('settings:manage')
  @Put(':id/image')
  setImage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SetPromoLandingImageDto,
  ): Promise<PromoLandingDto> {
    return this.promos.setImage(user.tenantId, id, body.heroImageKey);
  }
}
