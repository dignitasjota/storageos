import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  type AdminSubdomainCheckDto,
  type AdminTenantSubdomainDto,
  SetSubdomainReadySchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminSubdomainsService } from './admin-subdomains.service';
import { AdminGuard } from './admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from './current-super-admin.decorator';
import { RequireSuperadmin } from './require-superadmin.decorator';

import type { Request } from 'express';

class SetSubdomainReadyDto extends createZodDto(SetSubdomainReadySchema) {}

/**
 * Subdominios de la plataforma (SEO web D4). Leer y comprobar: cualquier rol del
 * panel. Marcar como hecho: solo superadmin (es una acción de infraestructura).
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/subdomains')
export class AdminSubdomainsController {
  constructor(private readonly subdomains: AdminSubdomainsService) {}

  /** Subdominios pendientes de configurar en el proxy. */
  @Get()
  list(): Promise<AdminTenantSubdomainDto[]> {
    return this.subdomains.list();
  }

  /** Comprueba si el subdominio responde (solo lectura). */
  @Get(':tenantId/check')
  check(@Param('tenantId', new ParseUUIDPipe()) tenantId: string): Promise<AdminSubdomainCheckDto> {
    return this.subdomains.check(tenantId);
  }

  /** Marca el subdominio como creado en el proxy (o lo vuelve a pendiente). */
  @RequireSuperadmin()
  @Put(':tenantId')
  @HttpCode(HttpStatus.OK)
  async setReady(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() body: SetSubdomainReadyDto,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    await this.subdomains.setReady(tenantId, body.ready, {
      superAdminId: admin.sub,
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
    return { ok: true };
  }
}
