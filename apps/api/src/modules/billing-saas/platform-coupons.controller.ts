import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  CreatePlatformCouponSchema,
  type PlatformCouponDto,
  UpdatePlatformCouponSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { AdminGuard } from '../admin/admin.guard';
import {
  type AuthenticatedSuperAdmin,
  CurrentSuperAdmin,
} from '../admin/current-super-admin.decorator';
import { RequireSuperadmin } from '../admin/require-superadmin.decorator';
import { SuperAdminAuditService } from '../admin/super-admin-audit.service';

import { PlatformCouponsService } from './platform-coupons.service';

import type { Request } from 'express';

class CreatePlatformCouponDto extends createZodDto(CreatePlatformCouponSchema) {}
class UpdatePlatformCouponDto extends createZodDto(UpdatePlatformCouponSchema) {}

/**
 * Gestión de cupones de plataforma (super admin). Palanca de conversión: un
 * descuento aplicable al cobro manual de la suscripción SaaS de un tenant.
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/coupons')
export class PlatformCouponsController {
  constructor(
    private readonly coupons: PlatformCouponsService,
    private readonly audit: SuperAdminAuditService,
  ) {}

  @Get()
  async list(): Promise<PlatformCouponDto[]> {
    return this.coupons.list();
  }

  @RequireSuperadmin()
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() input: CreatePlatformCouponDto,
    @Req() req: Request,
  ): Promise<PlatformCouponDto> {
    const coupon = await this.coupons.create(input);
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.coupon.created',
      targetType: 'platform_coupon',
      targetId: coupon.id,
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
      changes: {
        code: coupon.code,
        discountType: coupon.discountType,
        discountValue: coupon.discountValue,
        maxUses: coupon.maxUses,
      },
    });
    return coupon;
  }

  @RequireSuperadmin()
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  async update(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdatePlatformCouponDto,
    @Req() req: Request,
  ): Promise<PlatformCouponDto> {
    const coupon = await this.coupons.update(id, input);
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.coupon.updated',
      targetType: 'platform_coupon',
      targetId: coupon.id,
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
      changes: { ...input },
    });
    return coupon;
  }
}
