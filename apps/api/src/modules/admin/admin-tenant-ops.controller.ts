import {
  BadRequestException,
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
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  AdminFollowupKindEnum,
  AdminFollowupTabEnum,
  AdminTrialFilterEnum,
  BulkAdminFollowupsSchema,
  BulkProposeAddonSchema,
  CreateAdminFollowupSchema,
  DismissAddonOpportunitySchema,
  HandOffOpportunitySchema,
  UpdateAdminFollowupSchema,
  type AdminExpiredTrialDto,
  type AdminFollowupInboxDto,
  type AdminFollowupItemDto,
  type AdminFollowupsOverdueCountDto,
  type AdminOpportunitiesOverviewDto,
  type AdminOpportunityDismissalDto,
  type AdminTrialsPageDto,
  type BulkAdminFollowupsResultDto,
  type BulkProposePreviewDto,
  type BulkProposeResultDto,
  type HandOffOpportunityResultDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminFollowupsInboxService } from './admin-followups-inbox.service';
import { AdminOpportunitiesOpsService } from './admin-opportunities-ops.service';
import { AdminTrialsOpsService } from './admin-trials-ops.service';
import { AdminGuard } from './admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from './current-super-admin.decorator';
import { RequireSuperadmin } from './require-superadmin.decorator';

import type { Request } from 'express';

class CreateAdminFollowupDto extends createZodDto(CreateAdminFollowupSchema) {}
class UpdateAdminFollowupDto extends createZodDto(UpdateAdminFollowupSchema) {}
class BulkAdminFollowupsDto extends createZodDto(BulkAdminFollowupsSchema) {}
class DismissOpportunityDto extends createZodDto(DismissAddonOpportunitySchema) {}
class BulkProposeAddonDto extends createZodDto(BulkProposeAddonSchema) {}
class BulkProposePreviewDtoIn extends createZodDto(
  z.object({
    addonId: z.string().uuid(),
    tenantIds: z.array(z.string().uuid()).min(1).max(100),
    trialDays: z.number().int().min(1).max(60).optional(),
  }),
) {}
class HandOffOpportunityDto extends createZodDto(HandOffOpportunitySchema) {}

function actorOf(admin: AuthenticatedSuperAdmin, req: Request) {
  return {
    superAdminId: admin.sub,
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
  };
}

/** Un valor de enum de la query o 400. */
function parseEnum<T extends string>(schema: z.ZodType<T>, value: string | undefined, fallback: T) {
  if (value === undefined || value === '') return fallback;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequestException({ code: 'invalid_query', message: `Valor no válido: ${value}` });
  }
  return parsed.data;
}

/** Bandeja unificada de seguimientos (tenants y leads). */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/followups')
export class AdminFollowupsInboxController {
  constructor(private readonly inbox: AdminFollowupsInboxService) {}

  /**
   * `tab` (today · overdue · upcoming · done), `search`, `assignedTo`
   * (id o `none`), `mine=1` y `kind` (tenant · lead).
   */
  @Get('inbox')
  list(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Query('tab') tab?: string,
    @Query('search') search?: string,
    @Query('assignedTo') assignedTo?: string,
    @Query('mine') mine?: string,
    @Query('kind') kind?: string,
  ): Promise<AdminFollowupInboxDto> {
    if (assignedTo && assignedTo !== 'none' && !z.string().uuid().safeParse(assignedTo).success) {
      throw new BadRequestException({ code: 'invalid_query', message: 'Responsable no válido' });
    }
    const parsedKind = kind ? parseEnum(AdminFollowupKindEnum, kind, 'tenant') : undefined;
    return this.inbox.inbox({
      tab: parseEnum(AdminFollowupTabEnum, tab, 'today'),
      search,
      assignedTo: mine === '1' ? admin.sub : assignedTo,
      kind: parsedKind,
    });
  }

  /** Atrasados asignados a mí o sin asignar (aviso del menú). */
  @Get('overdue-count')
  async overdueCount(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
  ): Promise<AdminFollowupsOverdueCountDto> {
    return { count: await this.inbox.overdueCount(admin.sub) };
  }

  @Post()
  create(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() body: CreateAdminFollowupDto,
    @Req() req: Request,
  ): Promise<AdminFollowupItemDto> {
    return this.inbox.create(body, actorOf(admin, req));
  }

  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  bulk(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() body: BulkAdminFollowupsDto,
    @Req() req: Request,
  ): Promise<BulkAdminFollowupsResultDto> {
    return this.inbox.bulk(body, actorOf(admin, req));
  }

  /** Editar, marcar hecho (con «qué pasó») o reabrir. */
  @Patch('items/:kind/:id')
  update(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('kind') kind: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateAdminFollowupDto,
    @Req() req: Request,
  ): Promise<AdminFollowupItemDto> {
    return this.inbox.update(
      parseEnum(AdminFollowupKindEnum, kind, 'tenant'),
      id,
      body,
      actorOf(admin, req),
    );
  }
}

/** Trials con búsqueda, filtros, páginas y cifras, y las pruebas caducadas. */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/trials')
export class AdminTrialsOpsController {
  constructor(private readonly trials: AdminTrialsOpsService) {}

  @Get()
  page(
    @Query('search') search?: string,
    @Query('filter') filter?: string,
    @Query('salesRepId') salesRepId?: string,
    @Query('page') page?: string,
  ): Promise<AdminTrialsPageDto> {
    if (salesRepId && !z.string().uuid().safeParse(salesRepId).success) {
      throw new BadRequestException({ code: 'invalid_query', message: 'Comercial no válido' });
    }
    return this.trials.page({
      search,
      filter: parseEnum(AdminTrialFilterEnum, filter, 'all'),
      salesRepId,
      page: page ? Number.parseInt(page, 10) : 1,
    });
  }

  /** Pruebas que terminaron sin pagar (activas en solo lectura). */
  @Get('expired')
  expired(): Promise<AdminExpiredTrialDto[]> {
    return this.trials.expired();
  }
}

/** Oportunidades: vista completa, descartes, propuesta a varios y paso al comercial. */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/opportunities')
export class AdminOpportunitiesOpsController {
  constructor(private readonly ops: AdminOpportunitiesOpsService) {}

  @Get('overview')
  overview(): Promise<AdminOpportunitiesOverviewDto> {
    return this.ops.overview();
  }

  @RequireSuperadmin()
  @Post('dismissals')
  dismiss(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() body: DismissOpportunityDto,
    @Req() req: Request,
  ): Promise<AdminOpportunityDismissalDto> {
    return this.ops.dismiss(body, actorOf(admin, req));
  }

  @RequireSuperadmin()
  @Delete('dismissals/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async undismiss(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.ops.undismiss(id, actorOf(admin, req));
  }

  @Post('bulk-propose/preview')
  @HttpCode(HttpStatus.OK)
  bulkPreview(@Body() body: BulkProposePreviewDtoIn): Promise<BulkProposePreviewDto> {
    return this.ops.bulkPreview(body);
  }

  @RequireSuperadmin()
  @Post('bulk-propose')
  @HttpCode(HttpStatus.OK)
  bulkPropose(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() body: BulkProposeAddonDto,
    @Req() req: Request,
  ): Promise<BulkProposeResultDto> {
    return this.ops.bulkPropose(body, actorOf(admin, req));
  }

  @RequireSuperadmin()
  @Post('hand-off')
  @HttpCode(HttpStatus.OK)
  handOff(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() body: HandOffOpportunityDto,
    @Req() req: Request,
  ): Promise<HandOffOpportunityResultDto> {
    return this.ops.handOff(body, actorOf(admin, req));
  }
}
