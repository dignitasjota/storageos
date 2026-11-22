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
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  AdminCreateTenantSchema,
  CheckPlatformLeadDuplicatesSchema,
  CreatePlatformLeadActivitySchema,
  CreatePlatformLeadFollowupSchema,
  CreatePlatformLeadSchema,
  DiscardPlatformLeadSchema,
  LinkPlatformLeadTenantSchema,
  LosePlatformLeadSchema,
  MergePlatformLeadSchema,
  MessageAttachmentUploadSchema,
  MovePlatformLeadSchema,
  PlatformLeadBulkSchema,
  PlatformLeadCapturePhotoSchema,
  PlatformLeadCaptureSchema,
  PlatformLeadImportSchema,
  PlatformLeadListQuerySchema,
  PlatformLeadSourceEnum,
  PlatformLeadsQuerySchema,
  SendAdminQuoteSchema,
  SendPlatformLeadEmailSchema,
  SetPlatformLeadSequenceSchema,
  UpdatePlatformLeadFollowupSchema,
  UpdatePlatformLeadSchema,
  UpdatePlatformLeadSettingsSchema,
  UpsertPlatformLeadSequenceSchema,
  type ImportCommitDto,
  type ImportPreviewDto,
  type MessageAttachmentUploadDto,
  type PlatformLeadBoardDto,
  type PlatformLeadBulkResultDto,
  type PlatformLeadDetailDto,
  type PlatformLeadDuplicateDto,
  type PlatformLeadFollowupDto,
  type PlatformLeadListDto,
  type PlatformLeadSequenceDto,
  type PlatformLeadSettingsDto,
  type PlatformLeadStatsDto,
  type SalesTemplateDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../../common/decorators/public.decorator';
import { AdminGuard } from '../admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from '../current-super-admin.decorator';
import { RequireSuperadmin, SalesAccess } from '../require-superadmin.decorator';
import { SalesAccountsService } from '../sales/sales-accounts.service';
import { SalesContentService } from '../sales/sales-content.service';

import { PlatformLeadSequencesService } from './core/platform-lead-sequences.service';
import { PlatformLeadSettingsService } from './platform-lead-settings.service';
import { PlatformLeadToolsService } from './platform-lead-tools.service';
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
class MergeDto extends createZodDto(MergePlatformLeadSchema) {}
class DuplicatesDto extends createZodDto(CheckPlatformLeadDuplicatesSchema) {}
class SettingsDto extends createZodDto(UpdatePlatformLeadSettingsSchema) {}
class SequenceDto extends createZodDto(UpsertPlatformLeadSequenceSchema) {}
class SetSequenceDto extends createZodDto(SetPlatformLeadSequenceSchema) {}
class ImportDto extends createZodDto(PlatformLeadImportSchema) {}
class CaptureDto extends createZodDto(PlatformLeadCaptureSchema) {}
class CapturePhotoDto extends createZodDto(PlatformLeadCapturePhotoSchema) {}
class AttachmentUploadDto extends createZodDto(MessageAttachmentUploadSchema) {}

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
    ...(raw.discarded === '1' || raw.discarded === 'true' ? { discarded: true } : {}),
  });
  return parsed.success ? parsed.data : {};
}

const num = (v: string | undefined) => {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : undefined;
};

/** La lista se filtra por la URL: los textos vacíos o mal puestos se ignoran. */
function listQuery(raw: Record<string, string | undefined>) {
  const parsed = PlatformLeadListQuerySchema.safeParse({
    ...(raw.search?.trim() ? { search: raw.search.trim() } : {}),
    ...(raw.source ? { source: raw.source } : {}),
    ...(raw.assignedTo ? { assignedTo: raw.assignedTo } : {}),
    ...(raw.status ? { status: raw.status.split(',').filter(Boolean) } : {}),
    ...(num(raw.sizeMin) !== undefined ? { sizeMin: num(raw.sizeMin) } : {}),
    ...(num(raw.sizeMax) !== undefined ? { sizeMax: num(raw.sizeMax) } : {}),
    ...(raw.city?.trim() ? { city: raw.city.trim() } : {}),
    ...(raw.campaign?.trim() ? { campaign: raw.campaign.trim() } : {}),
    ...(num(raw.inactiveDays) ? { inactiveDays: num(raw.inactiveDays) } : {}),
    ...(raw.stale === '1' || raw.stale === 'true' ? { stale: true } : {}),
    ...(raw.discarded === '1' || raw.discarded === 'true' ? { discarded: true } : {}),
    ...(raw.sort ? { sort: raw.sort } : {}),
    ...(raw.dir ? { dir: raw.dir } : {}),
    ...(raw.cursor ? { cursor: raw.cursor } : {}),
    ...(num(raw.limit) ? { limit: num(raw.limit) } : {}),
  });
  if (!parsed.success) {
    throw new BadRequestException({ code: 'invalid_filters', message: 'Filtros no válidos' });
  }
  return parsed.data;
}

/**
 * Leads del panel admin (Tenants → Leads). Todo el equipo los trabaja; crear
 * su cuenta (como el alta de tenant), borrar un lead, los ajustes de reparto y
 * las secuencias, solo el rol superadmin. La captura rápida también la usan
 * los comerciales (su lead va a su cartera).
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/leads')
export class PlatformLeadsController {
  constructor(
    private readonly leads: PlatformLeadsService,
    private readonly tools: PlatformLeadToolsService,
    private readonly settings: PlatformLeadSettingsService,
    private readonly sequences: PlatformLeadSequencesService,
    private readonly content: SalesContentService,
    private readonly salesAccounts: SalesAccountsService,
  ) {}

  /**
   * Tablero: las fases abiertas (hasta 500, `truncated` si hay más); Cliente y
   * Perdido, los últimos. `?discarded=1`: los marcados «No es un lead».
   */
  @Get()
  board(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Query('search') search?: string,
    @Query('source') source?: string,
    @Query('assignedTo') assignedTo?: string,
    @Query('discarded') discarded?: string,
  ): Promise<PlatformLeadBoardDto> {
    return this.leads.board(query({ search, source, assignedTo, discarded }), admin.sub);
  }

  @Get('stats')
  stats(
    @Query('months') months?: string,
    @Query('source') source?: string,
  ): Promise<PlatformLeadStatsDto> {
    const parsed = source ? PlatformLeadSourceEnum.safeParse(source) : null;
    return this.leads.stats(Number(months) || 6, {
      source: parsed?.success ? parsed.data : null,
    });
  }

  /** Vista de lista: filtros, orden por columna y páginas (`cursor`). */
  @Get('list')
  list(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Query() raw: Record<string, string | undefined>,
  ): Promise<PlatformLeadListDto> {
    return this.tools.list(listQuery(raw), admin.sub);
  }

  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  bulk(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Body() body: unknown,
  ): Promise<PlatformLeadBulkResultDto> {
    // Unión discriminada por `action`: se valida aquí (createZodDto no la admite).
    const parsed = PlatformLeadBulkSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: parsed.error.issues[0]?.message ?? 'Datos no válidos',
      });
    }
    return this.tools.bulk(parsed.data, actor(admin, req));
  }

  /** Posibles duplicados de unos datos (al dar de alta): avisa, no bloquea. */
  @Post('duplicates')
  @HttpCode(HttpStatus.OK)
  duplicates(@Body() body: DuplicatesDto): Promise<PlatformLeadDuplicateDto[]> {
    return this.leads.possibleDuplicates({
      id: body.excludeId ?? null,
      email: body.email || null,
      phone: body.phone || null,
      companyName: body.companyName || null,
      contactName: body.contactName || null,
    });
  }

  @Get('settings')
  getSettings(): Promise<PlatformLeadSettingsDto> {
    return this.settings.dto();
  }

  @RequireSuperadmin()
  @Patch('settings')
  updateSettings(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() body: SettingsDto,
  ): Promise<PlatformLeadSettingsDto> {
    return this.settings.update(body, admin.sub);
  }

  /** Plantillas de correo (las de «Materiales y plantillas»), para escribir a un lead. */
  @Get('templates')
  async templates(): Promise<SalesTemplateDto[]> {
    return (await this.content.templates(true)).filter((t) => t.channel === 'email');
  }

  @Get('sequences')
  listSequences(): Promise<PlatformLeadSequenceDto[]> {
    return this.sequences.list();
  }

  @RequireSuperadmin()
  @Post('sequences')
  @HttpCode(HttpStatus.CREATED)
  createSequence(@Body() body: SequenceDto): Promise<PlatformLeadSequenceDto> {
    return this.sequences.save(null, body);
  }

  @RequireSuperadmin()
  @Patch('sequences/:sequenceId')
  updateSequence(
    @Param('sequenceId', new ParseUUIDPipe()) sequenceId: string,
    @Body() body: SequenceDto,
  ): Promise<PlatformLeadSequenceDto> {
    return this.sequences.save(sequenceId, body);
  }

  @RequireSuperadmin()
  @Delete('sequences/:sequenceId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteSequence(
    @Param('sequenceId', new ParseUUIDPipe()) sequenceId: string,
  ): Promise<void> {
    await this.sequences.remove(sequenceId);
  }

  /** Importar leads de un CSV o Excel: primero la vista previa, luego la importación. */
  @Post('import/preview')
  @HttpCode(HttpStatus.OK)
  importPreview(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Body() body: ImportDto,
  ): Promise<ImportPreviewDto> {
    return this.tools.importPreview(body, actor(admin, req));
  }

  @Post('import/commit')
  @HttpCode(HttpStatus.OK)
  importCommit(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Body() body: ImportDto,
  ): Promise<ImportCommitDto> {
    return this.tools.importCommit(body, actor(admin, req));
  }

  /** Captura rápida (móvil): la foto de su tarjeta. También para los comerciales. */
  @SalesAccess()
  @Post('capture/photo-upload-url')
  @HttpCode(HttpStatus.OK)
  capturePhotoUrl(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() body: CapturePhotoDto,
  ) {
    return this.tools.capturePhotoUrl(admin.sub, body.mimeType);
  }

  /**
   * Captura rápida: nombre, empresa, teléfono o email, nota y foto. Si lo da de
   * alta un comercial, va a su cartera (con las reglas de sus prospectos).
   */
  @SalesAccess()
  @Post('capture')
  @HttpCode(HttpStatus.CREATED)
  async capture(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Body() body: CaptureDto,
  ): Promise<{ leadId: string }> {
    const who = actor(admin, req);
    let leadId: string;
    if (admin.role === 'sales') {
      const account = await this.salesAccounts.createProspect(
        admin.sub,
        {
          companyName: body.companyName || undefined,
          contactName: body.contactName || undefined,
          email: body.email || undefined,
          phone: body.phone || undefined,
          note: body.note || undefined,
        },
        { repId: admin.sub, ipAddress: who.ipAddress ?? null, userAgent: who.userAgent ?? null },
      );
      leadId = account.lead.id;
    } else {
      const lead = await this.leads.create(
        {
          source: body.source,
          companyName: body.companyName ?? '',
          contactName: body.contactName ?? '',
          email: body.email ?? '',
          phone: body.phone ?? '',
          message: body.note ?? '',
        },
        who,
      );
      leadId = lead.id;
    }
    if (body.photoKey) await this.tools.attachCapturePhoto(leadId, body.photoKey, admin.sub);
    return { leadId };
  }

  @Get('export.csv')
  async exportCsv(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Res() res: Response,
    @Query('search') search?: string,
    @Query('source') source?: string,
    @Query('assignedTo') assignedTo?: string,
    @Query('discarded') discarded?: string,
    @Query('ids') ids?: string,
  ): Promise<void> {
    const selected = (ids ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter((x) => /^[0-9a-f-]{36}$/i.test(x))
      .slice(0, 500);
    const csv = await this.leads.exportCsv(
      query({ search, source, assignedTo, discarded }),
      admin.sub,
      selected,
    );
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
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('followupId', new ParseUUIDPipe()) followupId: string,
    @Body() body: UpdatePlatformLeadFollowupDto,
  ): Promise<PlatformLeadFollowupDto> {
    return this.leads.updateFollowup(followupId, body, actor(admin, req));
  }

  @Delete('followups/:followupId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteFollowup(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('followupId', new ParseUUIDPipe()) followupId: string,
  ) {
    await this.leads.deleteFollowup(followupId, actor(admin, req));
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
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
  ): Promise<PlatformLeadDetailDto> {
    return this.leads.update(id, body, admin.sub, actor(admin, req));
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

  /** «No es un lead» (con su motivo): sale del tablero y de las cifras. */
  @Post(':id/discard')
  @HttpCode(HttpStatus.NO_CONTENT)
  async discard(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body?: Record<string, unknown>,
  ): Promise<void> {
    const parsed = DiscardPlatformLeadSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({ code: 'invalid_reason', message: 'Motivo no válido' });
    }
    await this.leads.discard(id, actor(admin, req), parsed.data);
  }

  /** Une otro lead (`sourceId`) a este: el otro queda descartado como «Fusionado». */
  @Post(':id/merge')
  @HttpCode(HttpStatus.OK)
  merge(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: MergeDto,
  ): Promise<PlatformLeadDetailDto> {
    return this.tools.merge(id, body.sourceId, actor(admin, req));
  }

  /** Activa o para los correos automáticos (secuencia) de este lead. */
  @Post(':id/sequence')
  @HttpCode(HttpStatus.OK)
  setSequence(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SetSequenceDto,
  ): Promise<PlatformLeadDetailDto> {
    return this.leads.setSequence(id, body, actor(admin, req));
  }

  /** URL para subir un adjunto (imagen o PDF) de un correo a este lead. */
  @Post(':id/attachments/upload-url')
  @HttpCode(HttpStatus.OK)
  attachmentUploadUrl(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: AttachmentUploadDto,
  ): Promise<MessageAttachmentUploadDto> {
    return this.leads.attachmentUploadUrl(id, body.mimeType);
  }

  /** Recupera un lead marcado «No es un lead». */
  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  restore(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<PlatformLeadDetailDto> {
    return this.leads.restore(id, actor(admin, req));
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
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('activityId', new ParseUUIDPipe()) activityId: string,
  ): Promise<PlatformLeadDetailDto> {
    return this.leads.deleteActivity(id, activityId, actor(admin, req));
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
