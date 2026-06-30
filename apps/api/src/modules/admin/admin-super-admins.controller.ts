import {
  Body,
  Controller,
  ForbiddenException,
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
  CreateSuperAdminSchema,
  SetSuperAdminActiveSchema,
  type SuperAdminDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminGuard } from './admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from './current-super-admin.decorator';
import { SuperAdminAuditService } from './super-admin-audit.service';
import { SuperAdminService } from './super-admin.service';

import type { Request } from 'express';

class CreateSuperAdminDto extends createZodDto(CreateSuperAdminSchema) {}
class SetSuperAdminActiveDto extends createZodDto(SetSuperAdminActiveSchema) {}

/**
 * Gestión de super admins (listar, crear, activar/desactivar). Solo el rol
 * `superadmin` puede crear o desactivar (el rol `support` solo lee).
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/super-admins')
export class AdminSuperAdminsController {
  constructor(
    private readonly admins: SuperAdminService,
    private readonly audit: SuperAdminAuditService,
  ) {}

  @Get()
  async list(): Promise<SuperAdminDto[]> {
    return this.admins.list();
  }

  @Post()
  async create(
    @CurrentSuperAdmin() actor: AuthenticatedSuperAdmin,
    @Body() input: CreateSuperAdminDto,
    @Req() req: Request,
  ): Promise<SuperAdminDto> {
    this.assertSuperadmin(actor);
    const created = await this.admins.create({
      email: input.email,
      fullName: input.fullName,
      password: input.password,
      ...(input.role ? { role: input.role } : {}),
    });
    await this.audit.record({
      superAdminId: actor.sub,
      action: 'admin.super_admin.created',
      targetType: 'super_admin',
      targetId: created.id,
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
      changes: { email: created.email, role: created.role },
    });
    return created;
  }

  @Patch(':id/active')
  @HttpCode(HttpStatus.OK)
  async setActive(
    @CurrentSuperAdmin() actor: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: SetSuperAdminActiveDto,
    @Req() req: Request,
  ): Promise<SuperAdminDto> {
    this.assertSuperadmin(actor);
    const updated = await this.admins.setActive({
      actorId: actor.sub,
      targetId: id,
      isActive: input.isActive,
    });
    await this.audit.record({
      superAdminId: actor.sub,
      action: input.isActive ? 'admin.super_admin.reactivated' : 'admin.super_admin.deactivated',
      targetType: 'super_admin',
      targetId: id,
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
      changes: { isActive: input.isActive },
    });
    return updated;
  }

  /** Solo el rol `superadmin` gestiona otros super admins. */
  private assertSuperadmin(actor: AuthenticatedSuperAdmin): void {
    if (actor.role !== 'superadmin') {
      throw new ForbiddenException({
        code: 'insufficient_super_admin_role',
        message: 'Solo un super admin puede gestionar super admins',
      });
    }
  }
}
