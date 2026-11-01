import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  type ApplicationFeeReportDto,
  type PlatformPaymentSettingsDto,
  SetTenantApplicationFeeSchema,
  type TenantApplicationFeeDto,
  UpdatePlatformPaymentSettingsSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { PlatformPaymentSettingsService } from '../payments/stripe-connect/platform-payment-settings.service';

import { AdminGuard } from './admin.guard';
import { CurrentSuperAdmin } from './current-super-admin.decorator';
import { RequireSuperadmin } from './require-superadmin.decorator';
import { SuperAdminAuditService } from './super-admin-audit.service';

import type { Request } from 'express';

class UpdatePlatformPaymentSettingsDto extends createZodDto(UpdatePlatformPaymentSettingsSchema) {}
class SetTenantApplicationFeeDto extends createZodDto(SetTenantApplicationFeeSchema) {}

/** Comisión de la plataforma sobre los cobros de Stripe de los tenants. */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/payment-settings')
export class AdminPaymentSettingsController {
  constructor(
    private readonly settings: PlatformPaymentSettingsService,
    private readonly audit: SuperAdminAuditService,
  ) {}

  @Get()
  get(): Promise<PlatformPaymentSettingsDto> {
    return this.settings.get();
  }

  @RequireSuperadmin()
  @Put()
  @HttpCode(HttpStatus.OK)
  async update(
    @Body() input: UpdatePlatformPaymentSettingsDto,
    @CurrentSuperAdmin('sub') superAdminId: string,
    @Req() req: Request,
  ): Promise<PlatformPaymentSettingsDto> {
    const result = await this.settings.update(input);
    await this.audit.record({
      superAdminId,
      action: 'admin.payment_settings.updated',
      changes: { applicationFeePct: input.applicationFeePct },
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
    return result;
  }

  /** Tenants con una comisión propia (sustituye a la general). */
  @Get('tenants')
  tenantFees(): Promise<TenantApplicationFeeDto[]> {
    return this.settings.listTenantFees();
  }

  @RequireSuperadmin()
  @Put('tenants/:tenantId')
  @HttpCode(HttpStatus.OK)
  async setTenantFee(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() input: SetTenantApplicationFeeDto,
    @CurrentSuperAdmin('sub') superAdminId: string,
    @Req() req: Request,
  ): Promise<TenantApplicationFeeDto[]> {
    const result = await this.settings.setTenantFee(tenantId, input.applicationFeePct);
    await this.audit.record({
      superAdminId,
      action: 'admin.payment_settings.tenant_fee_changed',
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      changes: { applicationFeePct: input.applicationFeePct },
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
    return result;
  }

  /** Comisión cobrada por mes y los tenants que más dejan. */
  @Get('fee-report')
  feeReport(@Query('months') months?: string): Promise<ApplicationFeeReportDto> {
    return this.settings.feeReport(Number(months ?? 12));
  }
}
