import { Controller, Get, UseGuards } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';

/**
 * Endpoints publicos para integraciones externas autenticados via API key
 * (Bearer `sk_live_<tenantId>.<secret>`). Se marcan `@Public()` para que el
 * `JwtAuthGuard` global se desactive y solo aplique `ApiKeyGuard`.
 *
 * MVP scope: un solo endpoint `/integrations/whoami` que devuelve la
 * identidad asociada al token. Suficiente para que el tenant pruebe la
 * autenticacion antes de usar otros endpoints. Sub-bloques posteriores
 * iran anadiendo /integrations/invoices, /integrations/customers, etc.
 */
@Controller('integrations')
@Public()
@UseGuards(ApiKeyGuard)
export class IntegrationsApiController {
  @Get('whoami')
  whoami(@CurrentUser() user: AuthenticatedUser & { apiKeyId?: string }): {
    tenantId: string;
    apiKeyId: string | null;
  } {
    return {
      tenantId: user.tenantId,
      apiKeyId: user.apiKeyId ?? null,
    };
  }
}
