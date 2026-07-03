import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  AssignAddonSchema,
  UpsertSaasAddonSchema,
  type AdminAddonAnalyticsDto,
  type SaasAddonDto,
  type TenantBillingSummaryDto,
  type TenantLimitsDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { AdminGuard } from '../admin/admin.guard';

import { SaasAddonsService } from './saas-addons.service';

class UpsertSaasAddonDto extends createZodDto(UpsertSaasAddonSchema) {}
class AssignAddonDto extends createZodDto(AssignAddonSchema) {}

/**
 * Gestión del catálogo de add-ons facturables del SaaS y su asignación por
 * tenant. Solo super admin (`AdminGuard`). `@Public()` salta el JwtAuthGuard de
 * tenant (el caller es un super admin con su propio token).
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin')
export class SaasAddonsController {
  constructor(private readonly service: SaasAddonsService) {}

  @Get('addons/analytics')
  analytics(): Promise<AdminAddonAnalyticsDto[]> {
    return this.service.catalogAnalytics();
  }

  @Get('addons')
  listCatalog(): Promise<SaasAddonDto[]> {
    return this.service.listCatalog();
  }

  @Post('addons')
  createAddon(@Body() body: UpsertSaasAddonDto): Promise<SaasAddonDto> {
    return this.service.createAddon(body);
  }

  @Patch('addons/:id')
  updateAddon(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpsertSaasAddonDto,
  ): Promise<SaasAddonDto> {
    return this.service.updateAddon(id, body);
  }

  @Get('tenants/:id/limits')
  tenantLimits(@Param('id', new ParseUUIDPipe()) id: string): Promise<TenantLimitsDto> {
    return this.service.tenantLimits(id);
  }

  @Get('tenants/:id/billing-summary')
  billingSummary(@Param('id', new ParseUUIDPipe()) id: string): Promise<TenantBillingSummaryDto> {
    return this.service.billingSummary(id);
  }

  @Post('tenants/:id/addons')
  assign(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: AssignAddonDto,
  ): Promise<TenantBillingSummaryDto> {
    return this.service.assign(id, body);
  }

  @Delete('tenants/:id/addons/:assignmentId')
  remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string,
  ): Promise<TenantBillingSummaryDto> {
    return this.service.remove(id, assignmentId);
  }

  @Post('tenants/:id/addons/:assignmentId/suspend')
  suspend(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string,
  ): Promise<TenantBillingSummaryDto> {
    return this.service.suspend(id, assignmentId);
  }

  @Post('tenants/:id/addons/:assignmentId/reactivate')
  reactivate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string,
  ): Promise<TenantBillingSummaryDto> {
    return this.service.reactivate(id, assignmentId);
  }
}
