import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  type CampaignDto,
  type CampaignPreviewDto,
  CreateCampaignSchema,
  PreviewCampaignSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CampaignsService } from './campaigns.service';

class CreateCampaignDto extends createZodDto(CreateCampaignSchema) {}
class PreviewCampaignDto extends createZodDto(PreviewCampaignSchema) {}

@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @RequirePermission('communications:read')
  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<CampaignDto[]> {
    return this.campaigns.list(user.tenantId);
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
}
