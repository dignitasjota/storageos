import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  API_KEY_WILDCARD_SCOPE,
  type ApiKeyScope,
} from '../../modules/integrations/api-key-scopes';
import { ApiKeysService } from '../../modules/integrations/api-keys.service';
import { REQUIRE_SCOPE_KEY } from '../decorators/require-scope.decorator';

import type { AuthenticatedUser } from '../decorators/current-user.decorator';
import type { Request } from 'express';

/**
 * Guard de autenticacion via API key (token Bearer alternativo al JWT del
 * usuario). Espera un header:
 *
 *   Authorization: Bearer sk_live_<tenantId>.<secret>
 *
 * Si el token es valido, inyecta `request.user` con la forma estandar de
 * `AuthenticatedUser` pero con:
 *   - `sub = 'api-key:<apiKeyId>'`
 *   - `role = 'api'` (no es un UserRole real; no concede permisos de panel —
 *     la autorizacion de estos endpoints la decide `@RequireScope`, no el rol)
 *   - `apiKeyId` con el id de la fila autenticada
 *   - `apiKeyScopes` con los scopes persistidos (puede incluir `'*'`).
 *
 * Adicionalmente, tras validar el token, lee la metadata
 * `REQUIRE_SCOPE_KEY` del handler (decorador `@RequireScope`). Si el
 * endpoint la declara, comprueba que la API key incluya ese scope o el
 * wildcard `'*'`; si no, 403 `insufficient_scope`.
 *
 * No registrar este guard globalmente. Aplicar solo en endpoints
 * `/v1/integrations/*` que aceptan API key.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const token = extractBearer(req);
    if (!token || !token.startsWith('sk_live_')) {
      throw new UnauthorizedException({
        code: 'api_key_required',
        message: 'Falta header Authorization: Bearer sk_live_...',
      });
    }
    const result = await this.apiKeys.verify(token);
    if (!result) {
      throw new UnauthorizedException({
        code: 'api_key_invalid',
        message: 'API key invalida o revocada',
      });
    }

    const requiredScope = this.reflector.getAllAndOverride<ApiKeyScope | undefined>(
      REQUIRE_SCOPE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (requiredScope) {
      const grants = result.scopes;
      const allowed = grants.includes(API_KEY_WILDCARD_SCOPE) || grants.includes(requiredScope);
      if (!allowed) {
        throw new ForbiddenException({
          code: 'insufficient_scope',
          message: `Esta API key no tiene el scope requerido: ${requiredScope}`,
          details: { requiredScope },
        });
      }
    }

    const user: AuthenticatedUser & { apiKeyId?: string; apiKeyScopes?: string[] } = {
      sub: `api-key:${result.apiKeyId}`,
      tenantId: result.tenantId,
      // 'api' no esta en UserRole; es seguro porque los endpoints de
      // integraciones autorizan por @RequireScope (scopes de la API key),
      // no por rol ni por @RequirePermission.
      role: 'api' as never,
      apiKeyId: result.apiKeyId,
      apiKeyScopes: result.scopes,
    };
    (req as unknown as { user: typeof user }).user = user;
    return true;
  }
}

function extractBearer(req: Request): string | null {
  const auth = req.headers['authorization'];
  if (!auth || typeof auth !== 'string') return null;
  if (!auth.toLowerCase().startsWith('bearer ')) return null;
  return auth.slice(7).trim();
}
