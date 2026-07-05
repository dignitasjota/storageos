import {
  Body,
  Controller,
  Delete,
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
import { UpsertSubscriptionPlanSchema, type SubscriptionPlanDto } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { AdminGuard } from '../admin/admin.guard';
import {
  type AuthenticatedSuperAdmin,
  CurrentSuperAdmin,
} from '../admin/current-super-admin.decorator';
import { RequireSuperadmin } from '../admin/require-superadmin.decorator';
import { SuperAdminAuditService } from '../admin/super-admin-audit.service';

import { SubscriptionPlansService } from './subscription-plans.service';

import type { Request } from 'express';

class UpsertSubscriptionPlanDto extends createZodDto(UpsertSubscriptionPlanSchema) {}
class UpdateSubscriptionPlanDto extends createZodDto(UpsertSubscriptionPlanSchema.partial()) {}

/** Extrae IP + user-agent del request para dejar rastro en la auditoría. */
function extractMeta(req: Request): { ipAddress: string | null; userAgent: string | null } {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
  };
}

/**
 * CRUD de planes de suscripcion SaaS.
 *
 * - `GET /subscription-plans` es PUBLICO porque la landing / pricing publica
 *   lo necesita para listar tarifas sin sesion.
 * - `GET /subscription-plans/admin` y las mutaciones gestionan el catalogo de
 *   planes de la PLATAFORMA, por lo que solo un super admin debe tocarlos. Se
 *   protegen con `@UseGuards(AdminGuard)` (JWT `purpose='superadmin'`). El
 *   `@Public()` por endpoint salta el `JwtAuthGuard` global de tenant; el
 *   caller no es un user de tenant sino un super admin con su propio token.
 */
@Controller('subscription-plans')
export class SubscriptionPlansController {
  constructor(
    private readonly service: SubscriptionPlansService,
    private readonly audit: SuperAdminAuditService,
  ) {}

  @Public()
  @Get()
  async list(): Promise<SubscriptionPlanDto[]> {
    return this.service.list();
  }

  @Public()
  @UseGuards(AdminGuard)
  @Get('admin')
  async listAll(): Promise<SubscriptionPlanDto[]> {
    return this.service.listAll();
  }

  @Public()
  @UseGuards(AdminGuard)
  @RequireSuperadmin()
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() input: UpsertSubscriptionPlanDto,
    @Req() req: Request,
  ): Promise<SubscriptionPlanDto> {
    const created = await this.service.create(input);
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.plan.created',
      targetType: 'subscription_plan',
      targetId: created.id,
      changes: { slug: created.slug, name: created.name, priceMonthly: created.priceMonthly },
      ...extractMeta(req),
    });
    return created;
  }

  @Public()
  @UseGuards(AdminGuard)
  @RequireSuperadmin()
  @Patch(':id')
  async update(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateSubscriptionPlanDto,
    @Req() req: Request,
  ): Promise<SubscriptionPlanDto> {
    // El DTO partial declara las props como `slug?: string` (sin `| undefined`
    // por exactOptionalPropertyTypes); el service las acepta porque hace
    // spread condicional. Casteamos explicitamente para evitar warning.
    const updated = await this.service.update(
      id,
      input as Parameters<typeof this.service.update>[1],
    );
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.plan.updated',
      targetType: 'subscription_plan',
      targetId: id,
      changes: { slug: updated.slug, name: updated.name, priceMonthly: updated.priceMonthly },
      ...extractMeta(req),
    });
    return updated;
  }

  @Public()
  @UseGuards(AdminGuard)
  @RequireSuperadmin()
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deactivate(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.service.deactivate(id);
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.plan.deactivated',
      targetType: 'subscription_plan',
      targetId: id,
      ...extractMeta(req),
    });
  }
}
