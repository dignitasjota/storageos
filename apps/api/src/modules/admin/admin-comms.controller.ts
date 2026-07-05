import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  AdminBroadcastSchema,
  AdminEmailTenantSchema,
  RetentionPlaybookSchema,
  type AdminBroadcastResultDto,
  type AdminEmailTenantResultDto,
  type RetentionPlaybookResultDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminCommsService } from './admin-comms.service';
import { AdminGuard } from './admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from './current-super-admin.decorator';
import { RequireSuperadmin } from './require-superadmin.decorator';

import type { Request } from 'express';

class AdminEmailTenantDto extends createZodDto(AdminEmailTenantSchema) {}
class AdminBroadcastDto extends createZodDto(AdminBroadcastSchema) {}
class RetentionPlaybookDto extends createZodDto(RetentionPlaybookSchema) {}

function extractMeta(req: Request): { ipAddress: string | null; userAgent: string | null } {
  return { ipAddress: req.ip ?? null, userAgent: req.header('user-agent') ?? null };
}

@Public()
@UseGuards(AdminGuard)
@Controller('admin')
export class AdminCommsController {
  constructor(private readonly comms: AdminCommsService) {}

  /** Envía un email directo a un tenant (a sus owners / email de facturación). */
  @Post('tenants/:id/email')
  @HttpCode(HttpStatus.OK)
  async emailTenant(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: AdminEmailTenantDto,
    @Req() req: Request,
  ): Promise<AdminEmailTenantResultDto> {
    return this.comms.emailTenant(id, input, { superAdminId: admin.sub, ...extractMeta(req) });
  }

  /**
   * Playbook de retención (1 clic): crea seguimiento + envía email de retención
   * al owner + registra la interacción. Acción sensible → `@RequireSuperadmin`.
   */
  @RequireSuperadmin()
  @Post('tenants/:id/retention-playbook')
  @HttpCode(HttpStatus.OK)
  async retentionPlaybook(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: RetentionPlaybookDto,
    @Req() req: Request,
  ): Promise<RetentionPlaybookResultDto> {
    return this.comms.launchRetentionPlaybook(id, admin.sub, {
      ...(input.note ? { note: input.note } : {}),
      ...extractMeta(req),
    });
  }

  /** Envía un anuncio masivo a los tenants (según público). */
  @RequireSuperadmin()
  @Post('announcements')
  @HttpCode(HttpStatus.OK)
  async broadcast(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() input: AdminBroadcastDto,
    @Req() req: Request,
  ): Promise<AdminBroadcastResultDto> {
    return this.comms.broadcast(input, { superAdminId: admin.sub, ...extractMeta(req) });
  }
}
