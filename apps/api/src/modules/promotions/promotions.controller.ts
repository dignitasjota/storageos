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
  Query,
} from '@nestjs/common';
import {
  CreatePromotionSchema,
  CreateUnitOfferSchema,
  type UnitOfferDto,
  type PromotionDto,
  UpdatePromotionSchema,
  ValidatePromotionSchema,
  type ValidatePromotionResultDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { PromotionsService } from './promotions.service';

class CreatePromotionDto extends createZodDto(CreatePromotionSchema) {}
class UpdatePromotionDto extends createZodDto(UpdatePromotionSchema) {}
class ValidatePromotionDto extends createZodDto(ValidatePromotionSchema) {}
class CreateUnitOfferDto extends createZodDto(CreateUnitOfferSchema) {}

@Controller('promotions')
export class PromotionsController {
  constructor(private readonly promotions: PromotionsService) {}

  @RequirePermission('promotions:read')
  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<PromotionDto[]> {
    return this.promotions.list(user.tenantId);
  }

  /** Ofertas activas de trasteros concretos (`?unitId=` para uno). */
  @RequirePermission('promotions:read')
  @Get('unit-offers')
  listUnitOffers(
    @CurrentUser() user: AuthenticatedUser,
    @Query('unitId') unitId?: string,
  ): Promise<UnitOfferDto[]> {
    return this.promotions.activeUnitOffers(user.tenantId, unitId ? [unitId] : undefined);
  }

  /** Crea a mano una oferta para un trastero concreto (meses gratis, un solo uso). */
  @RequirePermission('promotions:manage')
  @Post('unit-offers')
  createUnitOffer(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateUnitOfferDto,
  ): Promise<UnitOfferDto> {
    return this.promotions.createUnitOffer(user.tenantId, body);
  }

  @RequirePermission('promotions:manage')
  @Delete('unit-offers/:unitId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancelUnitOffer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('unitId', new ParseUUIDPipe()) unitId: string,
  ): Promise<void> {
    await this.promotions.cancelUnitOffer(user.tenantId, unitId);
  }

  @RequirePermission('promotions:manage')
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreatePromotionDto,
  ): Promise<PromotionDto> {
    return this.promotions.create(user.tenantId, body);
  }

  @RequirePermission('promotions:manage')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdatePromotionDto,
  ): Promise<PromotionDto> {
    return this.promotions.update(user.tenantId, id, body);
  }

  @RequirePermission('promotions:manage')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.promotions.remove(user.tenantId, id);
  }

  /** Previsualiza el descuento de un código (usado por el wizard de contrato). */
  @RequirePermission('contracts:write')
  @Post('validate')
  @HttpCode(HttpStatus.OK)
  validate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ValidatePromotionDto,
  ): Promise<ValidatePromotionResultDto> {
    return this.promotions.validate(user.tenantId, body.code, body.monthlyPrice, body.unitId);
  }
}
