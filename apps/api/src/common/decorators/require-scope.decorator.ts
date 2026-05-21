import { SetMetadata } from '@nestjs/common';

import type { ApiKeyScope } from '../../modules/integrations/api-key-scopes';

export const REQUIRE_SCOPE_KEY = 'requireScope';

/**
 * Marca un handler que requiere un scope concreto en la API key utilizada.
 *
 *   @Get('invoices/:id')
 *   @RequireScope('invoices:read')
 *
 * Lo lee `ApiKeyGuard`. Endpoints sin este decorador no comprueban scopes
 * (cualquier API key activa pasa). Las keys con el wildcard interno `'*'`
 * tambien pasan cualquier check (compat con keys creadas sin scopes
 * explicitos).
 */
export const RequireScope = (scope: ApiKeyScope) => SetMetadata(REQUIRE_SCOPE_KEY, scope);
