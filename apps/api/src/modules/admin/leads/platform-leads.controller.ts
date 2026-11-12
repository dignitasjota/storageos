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
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  AdminCreateTenantSchema,
  CreatePlatformLeadActivitySchema,
  CreatePlatformLeadFollowupSchema,
  CreatePlatformLeadSchema,
  LinkPlatformLeadTenantSchema,
  LosePlatformLeadSchema,
  MovePlatformLeadSchema,
  PlatformLeadsQuerySchema,
  SendAdminQuoteSchema,
  SendPlatformLeadEmailSchema,
  UpdatePlatformLeadFollowupSchema,
  UpdatePlatformLeadSchema,
  type PlatformLeadBoardDto,
  type PlatformLeadDetailDto,
  type PlatformLeadFollowupDto,
  type PlatformLeadStatsDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../../common/decorators/public.decorator';
import { AdminGuard } from '../admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from '../current-super-admin.decorator';
import { RequireSuperadmin } from '../require-superadmin.decorator';

import { type LeadActor, PlatformLeadsService } from './platform-leads.service';

import type { Request, Response } from 'express';

class CreatePlatformLeadDto extends createZodDto(CreatePlatformLeadSchema) {}
class UpdatePlatformLeadDto extends createZodDto(UpdatePlatformLeadSchema) {}
class MovePlatformLeadDto extends createZodDto(MovePlatformLeadSchema) {}
class LosePlatformLeadDto extends createZodDto(LosePlatformLeadSchema) {}
class CreatePlatformLeadActivityDto extends createZodDto(CreatePlatformLeadActivitySchema) {}
class CreatePlatformLeadFollowupDto extends createZodDto(CreatePlatformLeadFollowupSchema) {}
class UpdatePlatformLeadFollowupDto extends createZodDto(UpdatePlatformLeadFollowupSchema) {}
class SendPlatformLeadEmailDto extends createZodDto(SendPlatformLeadEmailSchema) {}
class LinkPlatformLeadTenantDto extends createZodDto(LinkPlatformLeadTenantSchema) {}
class CreateTenantFromLeadDto extends createZodDto(AdminCreateTenantSchema) {}
class SendLeadQuoteDto extends createZodDto(SendAdminQuoteSchema) {}

const actor = (admin: AuthenticatedSuperAdmin, req: Request): LeadActor => ({
  superAdminId: admin.sub,
  ipAddress: req.ip ?? null,
  userAgent: req.header('user-agent') ?? null,
});

function query(raw: Record<string, string | undefined>) {
  const parsed = PlatformLeadsQuerySchema.safeParse({
    ...(raw.search?.trim() ? { search: raw.search.trim() } : {}),
    ...(raw.source ? { source: raw.source } : {}),
    ...(raw.assignedTo ? { assignedTo: raw.assignedTo } : {}),
  });
  return parsed.success ? parsed.data : {};
}

/**
 * Leads del panel admin (Tenants → Leads). Todo el equipo los trabaja; crear
 * su cuenta (como el alta de tenant) y borrar un lead, solo el rol superadmin.
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/leads')
export class PlatformLeadsController {
  constructor(private readonly leads: PlatformLeadsService) {}

  /** Tablero: las fases abiertas enteras; Cliente y Perdido, los últimos. */
  @Get()
  board(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Query('search') search?: string,
    @Query('source') source?: string,
    @Query('assignedTo') assignedTo?: string,
  ): Promise<PlatformLeadBoardDto> {
    return this.leads.board(query({ search, source, assignedTo }), admin.sub);
  }

  @Get('stats')
  stats(@Query('months') months?: string): Promise<PlatformLeadStatsDto> {
    return this.leads.stats(Number(months) || 6);
  }

  @Get('export.csv')
  async exportCsv(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Res() res: Response,
    @Query('search') search?: string,
    @Query('source') source?: string,
    @Query('assignedTo') assignedTo?: string,
  ): Promise<void> {
    const csv = await this.leads.exportCsv(query({ search, source, assignedTo }), admin.sub);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
    res.send(csv);
  }

  /** Seguimientos pendientes de todos los leads (`?mine=1`: los míos). */
  @Get('followups')
  followups(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Query('mine') mine?: string,
  ): Promise<PlatformLeadFollowupDto[]> {
    return this.leads.pendingFollowups(mine === '1' ? admin.sub : null);
  }

  @Patch('followups/:followupId')
  updateFollowup(
    @Param('followupId', new ParseUUIDPipe()) followupId: string,
    @Body() body: UpdatePlatformLeadFollowupDto,
  ): Promise<PlatformLeadFollowupDto> {
    return this.leads.updateFollowup(followupId, body);
  }

  @Delete('followups/:followupId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteFollowup(@Param('followupId', new ParseUUIDPipe()) followupId: string) {
    await this.leads.deleteFollowup(followupId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Body() body: CreatePlatformLeadDto,
  ): Promise<PlatformLeadDetailDto> {
    return this.leads.create(body, actor(admin, req));
  }

  @Get(':id')
  detail(@Param('id', new ParseUUIDPipe()) id: string): Promise<PlatformLeadDetailDto> {
    return this.leads.detail(id);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdatePlatformLeadDto,
  ): Promise<PlatformLeadDetailDto> {
    return this.leads.update(id, body);
  }

  @Post(':id/move')
  @HttpCode(HttpStatus.OK)
  move(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: MovePlatformLeadDto,
  ): Promise<PlatformLeadDetailDto> {
    return this.leads.move(id, body, actor(admin, req));
  }

  @Post(':id/lose')
  @HttpCode(HttpStatus.OK)
  lose(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: LosePlatformLeadDto,
  ): Promise<PlatformLeadDetailDto> {
    return this.leads.lose(id, body, actor(admin, req));
  }

  @Post(':id/reopen')
  @HttpCode(HttpStatus.OK)
  reopen(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<PlatformLeadDetailDto> {
    return this.leads.reopen(id, actor(admin, req));
  }

  /** «No es un lead»: sale del tablero y de las cifras. */
  @Post(':id/discard')
  @HttpCode(HttpStatus.NO_CONTENT)
  async discard(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.leads.discard(id, actor(admin, req));
  }

  @RequireSuperadmin()
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.leads.remove(id, actor(admin, req));
  }

  @Post(':id/activities')
  @HttpCode(HttpStatus.CREATED)
  createActivity(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CreatePlatformLeadActivityDto,
  ): Promise<PlatformLeadDetailDto> {
    return this.leads.createActivity(id, body, actor(admin, req));
  }

  @Delete(':id/activities/:activityId')
  @HttpCode(HttpStatus.OK)
  deleteActivity(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('activityId', new ParseUUIDPipe()) activityId: string,
  ): Promise<PlatformLeadDetailDto> {
    return this.leads.deleteActivity(id, activityId);
  }

  @Post(':id/followups')
  @HttpCode(HttpStatus.CREATED)
  createFollowup(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CreatePlatformLeadFollowupDto,
  ): Promise<PlatformLeadDetailDto> {
    return this.leads.createFollowup(id, body, actor(admin, req));
  }

  @Post(':id/email')
  @HttpCode(HttpStatus.OK)
  sendEmail(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SendPlatformLeadEmailDto,
  ): Promise<PlatformLeadDetailDto> {
    return this.leads.sendEmail(id, body, actor(admin, req));
  }

  /** Une el lead a una cuenta que ya existe (se registró por su cuenta). */
  @Post(':id/link')
  @HttpCode(HttpStatus.OK)
  link(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: LinkPlatformLeadTenantDto,
  ): Promise<PlatformLeadDetailDto> {
    return this.leads.link(id, body.tenantId, actor(admin, req));
  }

  /** Crea su cuenta (el alta de tenant de siempre) y la vincula. */
  @RequireSuperadmin()
  @Post(':id/create-tenant')
  @HttpCode(HttpStatus.CREATED)
  createTenant(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CreateTenantFromLeadDto,
  ): Promise<PlatformLeadDetailDto> {
    return this.leads.createTenant(id, body, actor(admin, req));
  }

  /** Propuesta del simulador: al lead por correo (o a su tenant si ya lo tiene). */
  @RequireSuperadmin()
  @Post(':id/quote')
  @HttpCode(HttpStatus.OK)
  sendQuote(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SendLeadQuoteDto,
  ): Promise<PlatformLeadDetailDto> {
    return this.leads.sendQuote(id, body, actor(admin, req));
  }
}
