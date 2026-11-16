import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  BadRequestException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  type CampaignDto,
  type CampaignEmailPreviewDto,
  CampaignEmailPreviewSchema,
  type CampaignPreviewDto,
  type CampaignResultsDto,
  type CampaignTemplateDto,
  CreateCampaignSchema,
  CreateCampaignTemplateSchema,
  CampaignAutomationKindEnum,
  type CampaignAutomationDto,
  CampaignRecipientFilterEnum,
  type CampaignRecipientDto,
  type CampaignSavedSegmentDto,
  CampaignTestSendSchema,
  type CampaignTestSendResultDto,
  SaveCampaignSegmentSchema,
  UpdateCampaignAutomationSchema,
  UpdateCampaignSchema,
  UpdateCampaignTemplateSchema,
  type WinbackPreviewDto,
  type WinbackStatsDto,
  PreviewCampaignSchema,
  UpdateWinbackSettingsSchema,
  type WinbackRunResultDto,
  type WinbackSettingsResponse,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CampaignAutomationsService } from './campaign-automations.service';
import { CampaignInsightsService } from './campaign-insights.service';
import { type CampaignActor, CampaignsService, assertWholeBusiness } from './campaigns.service';
import { WinbackService } from './winback.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateCampaignDto extends createZodDto(CreateCampaignSchema) {}
class UpdateCampaignDto extends createZodDto(UpdateCampaignSchema) {}
class PreviewCampaignDto extends createZodDto(PreviewCampaignSchema) {}
class UpdateWinbackSettingsDto extends createZodDto(UpdateWinbackSettingsSchema) {}
class CreateCampaignTemplateDto extends createZodDto(CreateCampaignTemplateSchema) {}
class UpdateCampaignTemplateDto extends createZodDto(UpdateCampaignTemplateSchema) {}
class CampaignEmailPreviewBodyDto extends createZodDto(CampaignEmailPreviewSchema) {}
class CampaignTestSendDto extends createZodDto(CampaignTestSendSchema) {}
class SaveCampaignSegmentDto extends createZodDto(SaveCampaignSegmentSchema) {}
class UpdateCampaignAutomationDto extends createZodDto(UpdateCampaignAutomationSchema) {}

@Controller('campaigns')
export class CampaignsController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly winback: WinbackService,
    private readonly insights: CampaignInsightsService,
    private readonly automations: CampaignAutomationsService,
  ) {}

  @RequirePermission('communications:read')
  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<CampaignDto[]> {
    return this.campaigns.list(user.tenantId, user.facilityScope ?? null);
  }

  // --- Win-back automático (antes de `:id` para no colisionar) -------------

  @RequirePermission('communications:read')
  @Get('winback-settings')
  getWinback(@CurrentUser() user: AuthenticatedUser): Promise<WinbackSettingsResponse> {
    return this.winback.getSettings(user.tenantId);
  }

  /** El win-back es de toda la empresa: lo configuran propietario y gestor. */
  @RequirePermission('automations:manage')
  @Patch('winback-settings')
  updateWinback(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateWinbackSettingsDto,
    @Req() req: Request,
  ): Promise<WinbackSettingsResponse> {
    assertWholeBusiness(user.facilityScope, 'El win-back');
    return this.winback.updateSettings(user.tenantId, body, actor(user, req));
  }

  /** A cuántos ex-clientes escribiría «Enviar ahora». */
  @RequirePermission('automations:manage')
  @Get('winback/preview')
  previewWinback(@CurrentUser() user: AuthenticatedUser): Promise<WinbackPreviewDto> {
    assertWholeBusiness(user.facilityScope, 'El win-back');
    return this.winback.preview(user.tenantId);
  }

  /** Ejecuta el win-back ahora (ignora la ventana de captura del arranque). */
  @RequirePermission('automations:manage')
  @Post('winback/run')
  @HttpCode(HttpStatus.OK)
  runWinback(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<WinbackRunResultDto> {
    assertWholeBusiness(user.facilityScope, 'El win-back');
    return this.winback.runNow(user.tenantId, actor(user, req));
  }

  @RequirePermission('communications:read')
  @Get('winback/stats')
  winbackStats(@CurrentUser() user: AuthenticatedUser): Promise<WinbackStatsDto> {
    return this.winback.stats(user.tenantId);
  }

  // --- Campañas automáticas (aniversario, contactos que no avanzan) ----------

  @RequirePermission('communications:read')
  @Get('automations')
  listAutomations(@CurrentUser() user: AuthenticatedUser): Promise<CampaignAutomationDto[]> {
    return this.automations.list(user.tenantId);
  }

  @RequirePermission('automations:manage')
  @Put('automations/:kind')
  updateAutomation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('kind') kind: string,
    @Body() body: UpdateCampaignAutomationDto,
    @Req() req: Request,
  ): Promise<CampaignAutomationDto[]> {
    assertWholeBusiness(user.facilityScope, 'Las campañas automáticas');
    const parsed = CampaignAutomationKindEnum.safeParse(kind);
    if (!parsed.success) {
      throw new BadRequestException({ code: 'invalid_kind', message: 'Tipo no válido' });
    }
    return this.automations.update(user.tenantId, parsed.data, body, actor(user, req));
  }

  // --- Segmentos guardados ----------------------------------------------------

  @RequirePermission('communications:read')
  @Get('segments')
  listSegments(@CurrentUser() user: AuthenticatedUser): Promise<CampaignSavedSegmentDto[]> {
    return this.insights.listSegments(user.tenantId);
  }

  @RequirePermission('communications:send')
  @Post('segments')
  saveSegment(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SaveCampaignSegmentDto,
    @Req() req: Request,
  ): Promise<CampaignSavedSegmentDto> {
    return this.insights.saveSegment(user.tenantId, body, actor(user, req));
  }

  @RequirePermission('communications:send')
  @Delete('segments/:segmentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeSegment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('segmentId', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.insights.removeSegment(user.tenantId, id);
  }

  /** Envía el correo de ejemplo a quien lo pide. */
  @RequirePermission('communications:send')
  @Post('test-send')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  testSend(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CampaignTestSendDto,
  ): Promise<CampaignTestSendResultDto> {
    return this.insights.testSend(user.tenantId, user.sub, body);
  }

  // --- Plantillas y vista previa --------------------------------------------

  @RequirePermission('communications:read')
  @Get('templates')
  listTemplates(@CurrentUser() user: AuthenticatedUser): Promise<CampaignTemplateDto[]> {
    return this.insights.listTemplates(user.tenantId);
  }

  @RequirePermission('communications:send')
  @Post('templates')
  createTemplate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateCampaignTemplateDto,
    @Req() req: Request,
  ): Promise<CampaignTemplateDto> {
    return this.insights.createTemplate(user.tenantId, body, actor(user, req));
  }

  @RequirePermission('communications:send')
  @Patch('templates/:templateId')
  updateTemplate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('templateId', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateCampaignTemplateDto,
    @Req() req: Request,
  ): Promise<CampaignTemplateDto> {
    return this.insights.updateTemplate(user.tenantId, id, body, actor(user, req));
  }

  @RequirePermission('communications:send')
  @Delete('templates/:templateId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeTemplate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('templateId', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.insights.removeTemplate(user.tenantId, id, actor(user, req));
  }

  /** Cómo llegará el correo (con la marca del tenant y un destinatario de ejemplo). */
  @RequirePermission('communications:send')
  @Post('preview-email')
  @HttpCode(HttpStatus.OK)
  previewEmail(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CampaignEmailPreviewBodyDto,
  ): Promise<CampaignEmailPreviewDto> {
    return this.insights.previewEmail(user.tenantId, body);
  }

  @RequirePermission('communications:read')
  @Get(':id/results')
  results(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CampaignResultsDto> {
    return this.insights.results(user.tenantId, id, user.facilityScope ?? null);
  }

  /** Quién la recibió según qué pasó (pulsaron, rebotaron, se dieron de baja…). */
  @RequirePermission('communications:read')
  @Get(':id/recipients')
  recipients(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('filter') filter?: string,
  ): Promise<CampaignRecipientDto[]> {
    const parsed = CampaignRecipientFilterEnum.safeParse(filter);
    if (!parsed.success) {
      throw new BadRequestException({ code: 'invalid_filter', message: 'Filtro no válido' });
    }
    return this.insights.recipients(user.tenantId, id, parsed.data, user.facilityScope ?? null);
  }

  @RequirePermission('communications:read')
  @Get(':id')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CampaignDto> {
    return this.campaigns.detail(user.tenantId, id, user.facilityScope ?? null);
  }

  /** Previsualiza el tamaño de la audiencia (sin crear ni enviar). */
  @RequirePermission('communications:send')
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  preview(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: PreviewCampaignDto,
  ): Promise<CampaignPreviewDto> {
    return this.campaigns.preview(
      user.tenantId,
      body.segment,
      user.facilityScope ?? null,
      body.channel,
    );
  }

  @RequirePermission('communications:send')
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateCampaignDto,
    @Req() req: Request,
  ): Promise<CampaignDto> {
    return this.campaigns.create({ tenantId: user.tenantId, actor: actor(user, req), input: body });
  }

  /** Cambia un borrador. */
  @RequirePermission('communications:send')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateCampaignDto,
    @Req() req: Request,
  ): Promise<CampaignDto> {
    return this.campaigns.update({
      tenantId: user.tenantId,
      id,
      actor: actor(user, req),
      input: body,
    });
  }

  /** Copia una campaña en un borrador nuevo. */
  @RequirePermission('communications:send')
  @Post(':id/duplicate')
  duplicate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<CampaignDto> {
    return this.campaigns.duplicate(user.tenantId, id, actor(user, req));
  }

  /** Borra un borrador o una campaña cancelada. */
  @RequirePermission('communications:send')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.campaigns.remove(user.tenantId, id, actor(user, req));
  }

  @RequirePermission('communications:send')
  @Post(':id/send')
  @HttpCode(HttpStatus.OK)
  sendCampaign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<CampaignDto> {
    return this.campaigns.send(user.tenantId, id, actor(user, req));
  }

  /** Cancela un borrador o una campaña programada que aún no ha salido. */
  @RequirePermission('communications:send')
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancelCampaign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<CampaignDto> {
    return this.campaigns.cancel(user.tenantId, id, actor(user, req));
  }
}

function actor(user: AuthenticatedUser, req: Request): CampaignActor {
  const ua = req.header('user-agent');
  const meta: RequestMeta = {
    ...(ua ? { userAgent: ua } : {}),
    ...(req.ip ? { ipAddress: req.ip } : {}),
  };
  return { userId: user.sub, scope: user.facilityScope ?? null, meta };
}
