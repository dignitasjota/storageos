import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  CreateRentIncreaseSchema,
  PreviewRentIncreaseSchema,
  type RentIncreaseDto,
  type RentIncreasePreviewDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { RentIncreasesService } from './rent-increases.service';

class CreateRentIncreaseDto extends createZodDto(CreateRentIncreaseSchema) {}
class PreviewRentIncreaseDto extends createZodDto(PreviewRentIncreaseSchema) {}

@Controller('rent-increases')
@RequireFeature('rent_increases')
export class RentIncreasesController {
  constructor(private readonly service: RentIncreasesService) {}

  @RequirePermission('contracts:read')
  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<RentIncreaseDto[]> {
    return this.service.list(user.tenantId);
  }

  @RequirePermission('contracts:read')
  @Get(':id')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<RentIncreaseDto> {
    return this.service.detail(user.tenantId, id);
  }

  /** Previsualiza los contratos afectados y el delta de MRR (sin persistir). */
  @RequirePermission('contracts:manage')
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  preview(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: PreviewRentIncreaseDto,
  ): Promise<RentIncreasePreviewDto> {
    return this.service.preview(user.tenantId, body);
  }

  @RequirePermission('contracts:manage')
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateRentIncreaseDto,
  ): Promise<RentIncreaseDto> {
    return this.service.create({ tenantId: user.tenantId, userId: user.sub, input: body });
  }

  @RequirePermission('contracts:manage')
  @Post(':id/apply')
  @HttpCode(HttpStatus.OK)
  apply(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<RentIncreaseDto> {
    return this.service.apply(user.tenantId, id);
  }

  @RequirePermission('contracts:manage')
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<RentIncreaseDto> {
    return this.service.cancel(user.tenantId, id);
  }
}
