import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  CreatePlatformSepaRemittanceSchema,
  type PlatformSepaRemittanceDto,
  type PlatformSepaRemittancePreviewDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../../common/decorators/public.decorator';
import { AdminGuard } from '../../admin/admin.guard';
import {
  type AuthenticatedSuperAdmin,
  CurrentSuperAdmin,
} from '../../admin/current-super-admin.decorator';
import { SuperAdminAuditService } from '../../admin/super-admin-audit.service';

import { PlatformSepaRemittanceService } from './platform-sepa-remittance.service';

import type { Request } from 'express';

class CreatePlatformSepaRemittanceDto extends createZodDto(CreatePlatformSepaRemittanceSchema) {}

function extractMeta(req: Request): { ipAddress: string | null; userAgent: string | null } {
  return { ipAddress: req.ip ?? null, userAgent: req.header('user-agent') ?? null };
}

/**
 * Remesas SEPA de plataforma (domiciliación de la cuota de los tenants en
 * modo 'sepa'). Solo super admin — espejo de `/sepa/remittances` del tenant
 * pero la línea es tenant+periodo, no factura.
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/platform-sepa/remittances')
export class PlatformSepaRemittanceController {
  constructor(
    private readonly remittances: PlatformSepaRemittanceService,
    private readonly audit: SuperAdminAuditService,
  ) {}

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  preview(): Promise<PlatformSepaRemittancePreviewDto> {
    return this.remittances.previewRemittance();
  }

  @Get()
  list(): Promise<PlatformSepaRemittanceDto[]> {
    return this.remittances.listRemittances();
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string): Promise<PlatformSepaRemittanceDto> {
    return this.remittances.getRemittance(id);
  }

  @Post()
  async create(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() body: CreatePlatformSepaRemittanceDto,
    @Req() req: Request,
  ): Promise<PlatformSepaRemittanceDto> {
    const dto = await this.remittances.createRemittance({ superAdminId: admin.sub, input: body });
    const meta = extractMeta(req);
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.platform_sepa.remittance_created',
      targetType: 'platform_sepa_remittance',
      targetId: dto.id,
      targetTenantId: null,
      changes: { name: dto.name, itemCount: dto.itemCount, total: dto.total },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return dto;
  }

  @Get(':id/xml')
  getXml(@Param('id', new ParseUUIDPipe()) id: string): Promise<{ filename: string; xml: string }> {
    return this.remittances.getXml(id);
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  async confirm(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<PlatformSepaRemittanceDto> {
    const dto = await this.remittances.confirmRemittance(id);
    const meta = extractMeta(req);
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.platform_sepa.remittance_confirmed',
      targetType: 'platform_sepa_remittance',
      targetId: id,
      targetTenantId: null,
      changes: { itemCount: dto.itemCount, total: dto.total },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return dto;
  }
}
