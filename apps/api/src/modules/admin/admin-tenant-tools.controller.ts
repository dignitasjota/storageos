import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
  AdminCreateTenantSchema,
  AdminSavedViewPageEnum,
  CreateAdminSavedViewSchema,
  SALES_SAVED_VIEW_PAGES,
  type AdminSavedViewPage,
  AdminResendAeatSchema,
  SnoozeRiskSchema,
  type AdminAeatActionResultDto,
  type AdminAnonymizePreviewDto,
  type AdminCreateTenantResultDto,
  type AdminSavedViewDto,
  type AdminUserSessionDto,
  type CustomDomainCheckDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminTenantToolsService } from './admin-tenant-tools.service';
import { AdminGuard } from './admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from './current-super-admin.decorator';
import { RequireSuperadmin, SalesAccess } from './require-superadmin.decorator';

import type { Request } from 'express';

class AdminCreateTenantDto extends createZodDto(AdminCreateTenantSchema) {}
class AdminResendAeatDto extends createZodDto(AdminResendAeatSchema) {}
class SnoozeRiskDto extends createZodDto(SnoozeRiskSchema) {}
class CreateAdminSavedViewDto extends createZodDto(CreateAdminSavedViewSchema) {}

/** Un comercial solo guarda (y ve) las vistas de sus pantallas. */
function assertViewPage(admin: AuthenticatedSuperAdmin, page: AdminSavedViewPage): void {
  if (admin.role === 'sales' && !SALES_SAVED_VIEW_PAGES.includes(page)) {
    throw new ForbiddenException({
      code: 'sales_not_allowed',
      message: 'Esta sección no está disponible para los comerciales',
    });
  }
}

const meta = (admin: AuthenticatedSuperAdmin, req: Request) => ({
  superAdminId: admin.sub,
  ipAddress: req.ip ?? null,
  userAgent: req.header('user-agent') ?? null,
});

/** Alta manual, anonimizar con vista previa, riesgo, DNS, AEAT, sesiones y vistas. */
@Public()
@UseGuards(AdminGuard)
@Controller('admin')
export class AdminTenantToolsController {
  constructor(private readonly tools: AdminTenantToolsService) {}

  /** Alta manual de un tenant (venta asistida). */
  @RequireSuperadmin()
  @Post('tenants')
  @HttpCode(HttpStatus.CREATED)
  createTenant(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() body: AdminCreateTenantDto,
    @Req() req: Request,
  ): Promise<AdminCreateTenantResultDto> {
    return this.tools.createTenant(body, meta(admin, req));
  }

  @RequireSuperadmin()
  @Get('tenants/:id/anonymize-preview')
  anonymizePreview(@Param('id', ParseUUIDPipe) id: string): Promise<AdminAnonymizePreviewDto> {
    return this.tools.anonymizePreview(id);
  }

  /** «Ignorar» en la lista de riesgo unos días (también el rol soporte). */
  @Post('tenants/:id/risk-snooze')
  @HttpCode(HttpStatus.OK)
  snooze(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SnoozeRiskDto,
    @Req() req: Request,
  ): Promise<{ until: string }> {
    return this.tools.snoozeRisk(id, body, meta(admin, req));
  }

  @Delete('tenants/:id/risk-snooze')
  @HttpCode(HttpStatus.NO_CONTENT)
  unsnooze(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.tools.unsnoozeRisk(id, meta(admin, req));
  }

  /** Comprueba ahora el DNS del dominio propio. */
  @Post('tenants/:id/custom-domain/check')
  @HttpCode(HttpStatus.OK)
  checkDomain(@Param('id', ParseUUIDPipe) id: string): Promise<CustomDomainCheckDto> {
    return this.tools.checkCustomDomain(id);
  }

  /** Consulta en la AEAT el estado de una factura de un tenant. */
  @Post('billing-health/invoices/:invoiceId/refresh-aeat')
  @HttpCode(HttpStatus.OK)
  refreshAeat(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
    @Req() req: Request,
  ): Promise<AdminAeatActionResultDto> {
    return this.tools.refreshAeat(invoiceId, meta(admin, req));
  }

  /** Vuelve a enviar la factura a la AEAT. */
  @RequireSuperadmin()
  @Post('billing-health/invoices/:invoiceId/resend-aeat')
  @HttpCode(HttpStatus.OK)
  resendAeat(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
    @Body() body: AdminResendAeatDto,
    @Req() req: Request,
  ): Promise<AdminAeatActionResultDto> {
    return this.tools.resendAeat(invoiceId, body.reason, meta(admin, req));
  }

  @Get('tenants/:id/users/:userId/sessions')
  sessions(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<AdminUserSessionDto[]> {
    return this.tools.listUserSessions(id, userId);
  }

  @RequireSuperadmin()
  @Delete('tenants/:id/users/:userId/sessions/:sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  revokeSession(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.tools.revokeUserSession(id, userId, sessionId, meta(admin, req));
  }

  /** Vistas guardadas de cada super admin (las suyas; un comercial, las de sus pantallas). */
  @SalesAccess()
  @Get('saved-views')
  views(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Query('page') page?: string,
  ): Promise<AdminSavedViewDto[]> {
    const parsed = AdminSavedViewPageEnum.safeParse(page ?? 'tenants');
    if (!parsed.success) {
      throw new BadRequestException({ code: 'invalid_page', message: 'Lista no válida' });
    }
    assertViewPage(admin, parsed.data);
    return this.tools.listViews(admin.sub, parsed.data);
  }

  @SalesAccess()
  @Post('saved-views')
  saveView(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() body: CreateAdminSavedViewDto,
  ): Promise<AdminSavedViewDto> {
    assertViewPage(admin, body.page);
    return this.tools.saveView(admin.sub, body);
  }

  /** Borra una vista suya (de cualquier lista: solo puede tener las suyas). */
  @SalesAccess()
  @Delete('saved-views/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteView(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.tools.deleteView(admin.sub, id);
  }
}
