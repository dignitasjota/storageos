import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  type AdminTenantDto,
  AdminTenantActionSchema,
  ExtendTrialSchema,
  type ImpersonationTokenDto,
  ImpersonateSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminTenantsService } from './admin-tenants.service';
import { AdminGuard } from './admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from './current-super-admin.decorator';
import { ImpersonationService } from './impersonation.service';

import type { Request } from 'express';

class AdminTenantActionDto extends createZodDto(AdminTenantActionSchema) {}
class ExtendTrialDto extends createZodDto(ExtendTrialSchema) {}
class ImpersonateDto extends createZodDto(ImpersonateSchema) {}

interface RequestMetaInfo {
  ipAddress: string | null;
  userAgent: string | null;
}

function extractMeta(req: Request): RequestMetaInfo {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
  };
}

@Public()
@UseGuards(AdminGuard)
@Controller('admin/tenants')
export class AdminTenantsController {
  constructor(
    private readonly tenants: AdminTenantsService,
    private readonly impersonation: ImpersonationService,
  ) {}

  @Get()
  async list(
    @Query('search') search?: string,
    @Query('status') status?: string,
  ): Promise<AdminTenantDto[]> {
    return this.tenants.list({
      ...(search ? { search } : {}),
      ...(status ? { status } : {}),
    });
  }

  @Get(':id')
  async detail(@Param('id', new ParseUUIDPipe()) id: string): Promise<AdminTenantDto> {
    return this.tenants.detail(id);
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  async suspend(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: AdminTenantActionDto,
    @Req() req: Request,
  ): Promise<AdminTenantDto> {
    const meta = extractMeta(req);
    return this.tenants.suspend(id, {
      superAdminId: admin.sub,
      reason: input.reason,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  async reactivate(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: AdminTenantActionDto,
    @Req() req: Request,
  ): Promise<AdminTenantDto> {
    const meta = extractMeta(req);
    return this.tenants.reactivate(id, {
      superAdminId: admin.sub,
      reason: input.reason,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }

  @Post(':id/extend-trial')
  @HttpCode(HttpStatus.OK)
  async extendTrial(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: ExtendTrialDto,
    @Req() req: Request,
  ): Promise<AdminTenantDto> {
    const meta = extractMeta(req);
    return this.tenants.extendTrial(id, {
      superAdminId: admin.sub,
      reason: input.reason,
      days: input.days,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }

  @Post(':id/impersonate')
  @HttpCode(HttpStatus.OK)
  async impersonate(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: ImpersonateDto,
    @Req() req: Request,
  ): Promise<ImpersonationTokenDto> {
    const meta = extractMeta(req);
    return this.impersonation.impersonate({
      superAdminId: admin.sub,
      tenantId: id,
      reason: input.reason,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }
}
