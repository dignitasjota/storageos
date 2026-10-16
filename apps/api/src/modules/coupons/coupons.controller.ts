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
} from '@nestjs/common';
import {
  CreateCouponSchema,
  type CouponDto,
  type CouponQuoteDto,
  type CouponRedemptionDto,
  UpdateCouponSchema,
  ValidateCouponSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CouponsService } from './coupons.service';

class CreateCouponDto extends createZodDto(CreateCouponSchema) {}
class UpdateCouponDto extends createZodDto(UpdateCouponSchema) {}
class ValidateCouponDto extends createZodDto(ValidateCouponSchema) {}

@Controller('coupons')
export class CouponsController {
  constructor(private readonly coupons: CouponsService) {}

  @RequirePermission('promotions:read')
  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<CouponDto[]> {
    return this.coupons.list(user.tenantId);
  }

  @RequirePermission('promotions:manage')
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateCouponDto,
  ): Promise<CouponDto> {
    return this.coupons.create(user.tenantId, body);
  }

  /** Comprueba un cupón para un trastero y unos meses (alta de contrato). */
  @RequirePermission('contracts:write')
  @Post('validate')
  @HttpCode(HttpStatus.OK)
  validate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ValidateCouponDto,
  ): Promise<CouponQuoteDto> {
    return this.coupons.validateForUnit(user.tenantId, body);
  }

  @RequirePermission('promotions:read')
  @Get(':id/redemptions')
  redemptions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CouponRedemptionDto[]> {
    return this.coupons.listRedemptions(user.tenantId, id);
  }

  @RequirePermission('promotions:manage')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateCouponDto,
  ): Promise<CouponDto> {
    return this.coupons.update(user.tenantId, id, body);
  }

  @RequirePermission('promotions:manage')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.coupons.remove(user.tenantId, id);
  }
}
