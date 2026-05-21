import { Controller, Get, UseGuards } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { RequireScope } from '../../common/decorators/require-scope.decorator';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';

/**
 * Endpoints publicos para integraciones externas autenticados via API key
 * (Bearer `sk_live_<tenantId>.<secret>`). Se marcan `@Public()` para que el
 * `JwtAuthGuard` global se desactive y solo aplique `ApiKeyGuard`.
 *
 * Sub-bloque 15A.3: cada endpoint declara su scope minimo con
 * `@RequireScope`. Las API keys creadas sin scopes explicitos persisten con
 * el wildcard interno `'*'` y bypasean cualquier check (compat con keys
 * creadas en 14A.3). Endpoints nuevos publicos via API key se anadiran en
 * sub-bloques futuros segun los integradores los pidan (invoices,
 * customers, contracts, etc.).
 */
@Controller('integrations')
@Public()
@UseGuards(ApiKeyGuard)
export class IntegrationsApiController {
  /**
   * Smoke test: devuelve la identidad asociada al token. Requiere el scope
   * mas barato disponible (`invoices:read`) para que la primera integracion
   * tenga que pensar en scopes desde el minuto cero.
   */
  @Get('whoami')
  @RequireScope('invoices:read')
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
