import { randomUUID } from 'node:crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { SuperAdminAuditService } from './super-admin-audit.service';

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
    private readonly superAdminAudit: SuperAdminAuditService,
  ) {}

  async impersonate(args: ImpersonateArgs): Promise<ImpersonationTokenDto> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: args.tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({
        code: 'tenant_not_found',
        message: 'Tenant no encontrado',
      });
    }
    // Un tenant cancelado (baja/anonimizado) no debe poder "revivirse" via
    // impersonación; suspended SÍ se permite a propósito (soporte necesita
    // entrar a verificar datos antes de reactivar).
    if (tenant.status === 'cancelled') {
      throw new NotFoundException({
        code: 'tenant_cancelled',
        message: 'No se puede impersonar un tenant cancelado',
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

    // 🐛 Fix 2026-07-04: el `sub` era un UUID sintético que NO apuntaba a
    // ningún User real → toda escritura durante la impersonación que usara
    // `user.sub` como userId (audit_logs.userId, createdByUserId de
    // contratos/facturas…) violaba la FK: el audit se descartaba en silencio
    // (try/catch de AuditService) y las mutaciones daban 500. Ahora el token
    // se emite en nombre del OWNER activo del tenant (usuario real): las
    // acciones quedan registradas en audit_logs (atribuidas a ese usuario) y
    // la ventana del ImpersonationLog + el claim `superAdminId` identifican
    // al impersonador (la página /admin/impersonation ya cruza ambas).
    const owner = await this.admin.user.findFirst({
      where: { tenantId: tenant.id, role: 'owner', isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    // Sin owner activo (tenant vacío/anonimizado a medias): sub sintético
    // como antes — la impersonación sirve solo para lecturas.
    const subject = owner?.id ?? randomUUID();
    const accessToken = await this.jwt.signAsync(
      {
        tenantId: tenant.id,
        role: 'owner',
        purpose: 'impersonation',
        superAdminId: args.superAdminId,
      },
      {
        subject,
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

    // Log global del super admin tambien (sin tenant context): el audit
    // tenant queda en `audit_logs` y este queda en `super_admin_audit_logs`
    // para que un super admin pueda filtrar por su propia actividad.
    await this.superAdminAudit.record({
      superAdminId: args.superAdminId,
      action: 'admin.tenant.impersonate',
      targetType: 'tenant',
      targetId: tenant.id,
      targetTenantId: tenant.id,
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
      changes: {
        reason: args.reason,
        expiresAt: expiresAt.toISOString(),
      },
    });

    return {
      accessToken,
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      expiresIn: ttl,
    };
  }
}
