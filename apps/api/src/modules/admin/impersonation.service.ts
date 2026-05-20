import { randomUUID } from 'node:crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import type { Env } from '../../config/env.schema';
import type { ImpersonationTokenDto } from '@storageos/shared';

interface ImpersonateArgs {
  superAdminId: string;
  tenantId: string;
  reason: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Impersonacion controlada de un super admin a un tenant.
 *
 * Decision de diseño: el JWT emitido es compatible con `JwtStrategy` (mismo
 * shape `{ sub, tenantId, role }` y firmado con `JWT_ACCESS_SECRET`) para
 * que el resto de la API lo acepte sin tocar guards. Añadimos:
 *   - `purpose: 'impersonation'` -> rastreable.
 *   - `superAdminId: <id>` -> quien impersona, para audit.
 *   - `sub: <random uuid v4>` -> un id sintetico que NO coincide con
 *     ningun User real para evitar colisiones de auditoria; el resto del
 *     codigo solo lo usa para el claim del audit log.
 *
 * Persistimos un `ImpersonationLog` con `expiresAt = now + IMPERSONATION_TTL_SECONDS`
 * para auditoria. La expiracion real del JWT viene del propio token.
 */
@Injectable()
export class ImpersonationService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async impersonate(args: ImpersonateArgs): Promise<ImpersonationTokenDto> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: args.tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({
        code: 'tenant_not_found',
        message: 'Tenant no encontrado',
      });
    }
    const ttl = this.config.get('IMPERSONATION_TTL_SECONDS', { infer: true });
    const expiresAt = new Date(Date.now() + ttl * 1000);

    await this.admin.impersonationLog.create({
      data: {
        superAdminId: args.superAdminId,
        tenantId: args.tenantId,
        reason: args.reason,
        ipAddress: args.ipAddress ?? null,
        userAgent: args.userAgent ?? null,
        expiresAt,
      },
    });

    // `sub` sintetico (no apunta a un User real). El JWT se acepta por
    // JwtStrategy porque mantenemos el shape esperado; los servicios que
    // necesiten saber si la sesion es una impersonacion deben mirar el
    // claim `purpose === 'impersonation'`.
    const syntheticSub = randomUUID();
    const accessToken = await this.jwt.signAsync(
      {
        tenantId: tenant.id,
        role: 'owner',
        purpose: 'impersonation',
        superAdminId: args.superAdminId,
      },
      {
        subject: syntheticSub,
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
        expiresIn: ttl,
      },
    );

    await this.audit.write({
      tenantId: tenant.id,
      userId: null,
      action: 'admin.impersonation.started',
      entityType: 'Tenant',
      entityId: tenant.id,
      changes: {
        superAdminId: args.superAdminId,
        reason: args.reason,
        expiresAt: expiresAt.toISOString(),
      },
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
    });

    return {
      accessToken,
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      expiresIn: ttl,
    };
  }
}
