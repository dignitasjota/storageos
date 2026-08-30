import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { SuggestAdCampaignSchema, type AdCampaignDraftDto } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { AiService } from '../ai/ai.service';

class SuggestAdCampaignDto extends createZodDto(SuggestAdCampaignSchema) {}

@Controller('marketing')
export class AdCampaignDraftController {
  constructor(private readonly ai: AiService) {}

  /**
   * Borrador de campaña de Google/Meta Ads con IA (no publica nada — el
   * staff copia el texto en el gestor de campañas de la plataforma).
   * Gateado por la feature `ai_assistant` (invoca el proveedor de IA, de
   * pago) y por el permiso de marketing (no `ai:use`, es una acción de
   * marketing, no de chat general).
   */
  @RequirePermission('marketing:manage')
  @RequireFeature('ai_assistant')
  @Post('ad-campaign-draft')
  @HttpCode(HttpStatus.OK)
  suggest(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SuggestAdCampaignDto,
  ): Promise<AdCampaignDraftDto> {
    return this.ai.suggestAdCampaign({ tenantId: user.tenantId, input: body });
  }
}
