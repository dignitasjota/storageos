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
} from '@nestjs/common';
import {
  type CampaignDto,
  type CampaignEmailPreviewDto,
  CampaignEmailPreviewSchema,
  type CampaignPreviewDto,
  type CampaignResultsDto,
  type CampaignTemplateDto,
  CreateCampaignSchema,
  CreateCampaignTemplateSchema,
  UpdateCampaignTemplateSchema,
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

import { CampaignInsightsService } from './campaign-insights.service';
import { CampaignsService } from './campaigns.service';
import { WinbackService } from './winback.service';

class CreateCampaignDto extends createZodDto(CreateCampaignSchema) {}
class PreviewCampaignDto extends createZodDto(PreviewCampaignSchema) {}
class UpdateWinbackSettingsDto extends createZodDto(UpdateWinbackSettingsSchema) {}
class CreateCampaignTemplateDto extends createZodDto(CreateCampaignTemplateSchema) {}
class UpdateCampaignTemplateDto extends createZodDto(UpdateCampaignTemplateSchema) {}
class CampaignEmailPreviewBodyDto extends createZodDto(CampaignEmailPreviewSchema) {}

@Controller('campaigns')
export class CampaignsController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly winback: WinbackService,
    private readonly insights: CampaignInsightsService,
  ) {}

  @RequirePermission('communications:read')
  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<CampaignDto[]> {
    return this.campaigns.list(user.tenantId);
  }

  // --- Win-back automático (antes de `:id` para no colisionar) -------------

  @RequirePermission('communications:read')
  @Get('winback-settings')
  getWinback(@CurrentUser() user: AuthenticatedUser): Promise<WinbackSettingsResponse> {
    return this.winback.getSettings(user.tenantId);
  }

  @RequirePermission('communications:send')
  @Patch('winback-settings')
  updateWinback(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateWinbackSettingsDto,
  ): Promise<WinbackSettingsResponse> {
    return this.winback.updateSettings(user.tenantId, body);
  }

  /** Ejecuta el win-back ahora (ignora la ventana de captura del arranque). */
  @RequirePermission('communications:send')
  @Post('winback/run')
  @HttpCode(HttpStatus.OK)
  runWinback(@CurrentUser() user: AuthenticatedUser): Promise<WinbackRunResultDto> {
    return this.winback.runForTenant(user.tenantId, true);
  }

  @RequirePermission('communications:read')
  @Get('winback/stats')
  winbackStats(@CurrentUser() user: AuthenticatedUser): Promise<WinbackStatsDto> {
    return this.winback.stats(user.tenantId);
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
  ): Promise<CampaignTemplateDto> {
    return this.insights.createTemplate(user.tenantId, body);
  }

  @RequirePermission('communications:send')
  @Patch('templates/:templateId')
  updateTemplate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('templateId', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateCampaignTemplateDto,
  ): Promise<CampaignTemplateDto> {
    return this.insights.updateTemplate(user.tenantId, id, body);
  }

  @RequirePermission('communications:send')
  @Delete('templates/:templateId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeTemplate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('templateId', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.insights.removeTemplate(user.tenantId, id);
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
    return this.insights.results(user.tenantId, id);
  }

  @RequirePermission('communications:read')
  @Get(':id')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CampaignDto> {
    return this.campaigns.detail(user.tenantId, id);
  }

  /** Previsualiza el tamaño de la audiencia (sin crear ni enviar). */
  @RequirePermission('communications:send')
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  preview(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: PreviewCampaignDto,
  ): Promise<CampaignPreviewDto> {
    return this.campaigns.preview(user.tenantId, body.segment);
  }

  @RequirePermission('communications:send')
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateCampaignDto,
  ): Promise<CampaignDto> {
    return this.campaigns.create({ tenantId: user.tenantId, userId: user.sub, input: body });
  }

  @RequirePermission('communications:send')
  @Post(':id/send')
  @HttpCode(HttpStatus.OK)
  sendCampaign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CampaignDto> {
    return this.campaigns.send(user.tenantId, id);
  }

  /** Cancela un borrador o una campaña programada que aún no ha salido. */
  @RequirePermission('communications:send')
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancelCampaign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CampaignDto> {
    return this.campaigns.cancel(user.tenantId, id);
  }
}
