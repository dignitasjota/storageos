import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { ApiKeysService } from '../../modules/integrations/api-keys.service';

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
 *   - `role = 'api'` (no es un UserRole real; el RolesGuard que requiera
 *     `owner|manager` rechaza estas requests por diseno)
 *   - `apiKeyId` con el id de la fila autenticada
 *
 * No registrar este guard globalmente. Aplicar solo en endpoints
 * `/v1/integrations/*` que aceptan API key.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly apiKeys: ApiKeysService) {}

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
    const user: AuthenticatedUser & { apiKeyId?: string } = {
      sub: `api-key:${result.apiKeyId}`,
      tenantId: result.tenantId,
      // 'api' no esta en UserRole pero es seguro porque RolesGuard rechaza
      // cualquier rol distinto al esperado y los endpoints de integraciones
      // no usan @Roles.
      role: 'api' as never,
      apiKeyId: result.apiKeyId,
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
