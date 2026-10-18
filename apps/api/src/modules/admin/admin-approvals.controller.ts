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
  type AdminApprovalRequestDto,
  type ApprovalStatus,
  CreateApprovalRequestSchema,
  DecideApprovalRequestSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminApprovalsService } from './admin-approvals.service';
import { AdminGuard } from './admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from './current-super-admin.decorator';
import { RequireSuperadmin } from './require-superadmin.decorator';

import type { Request } from 'express';

function extractMeta(req: Request): { ipAddress: string | null; userAgent: string | null } {
  return { ipAddress: req.ip ?? null, userAgent: req.header('user-agent') ?? null };
}

class CreateApprovalRequestDto extends createZodDto(CreateApprovalRequestSchema) {}
class DecideApprovalRequestDto extends createZodDto(DecideApprovalRequestSchema) {}

const STATUSES = new Set<ApprovalStatus>(['pending', 'approved', 'rejected', 'failed']);

/**
 * Cola de aprobación: cualquier admin (normalmente el rol soporte) pide una
 * acción sobre un tenant; solo el super admin la aprueba o la rechaza.
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/approvals')
export class AdminApprovalsController {
  constructor(private readonly approvals: AdminApprovalsService) {}

  @Get()
  list(
    @Query('status') status?: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<AdminApprovalRequestDto[]> {
    return this.approvals.list({
      ...(status && STATUSES.has(status as ApprovalStatus)
        ? { status: status as ApprovalStatus }
        : {}),
      ...(tenantId && /^[0-9a-f-]{36}$/i.test(tenantId) ? { tenantId } : {}),
    });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() input: CreateApprovalRequestDto,
    @Req() req: Request,
  ): Promise<AdminApprovalRequestDto> {
    return this.approvals.create(input, { superAdminId: admin.sub, ...extractMeta(req) });
  }

  @RequireSuperadmin()
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: DecideApprovalRequestDto,
    @Req() req: Request,
  ): Promise<AdminApprovalRequestDto> {
    return this.approvals.approve(id, input.note, {
      superAdminId: admin.sub,
      ...extractMeta(req),
    });
  }

  @RequireSuperadmin()
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: DecideApprovalRequestDto,
    @Req() req: Request,
  ): Promise<AdminApprovalRequestDto> {
    return this.approvals.reject(id, input.note, {
      superAdminId: admin.sub,
      ...extractMeta(req),
    });
  }
}
