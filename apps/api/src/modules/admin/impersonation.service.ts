import { randomUUID } from 'node:crypto';

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  permissionsForRole,
  renderAdminEmail,
  type ImpersonationTokenDto,
  type Permission,
  type UserRole,
} from '@storageos/shared';

import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { EmailService } from '../email/email.service';

import { SuperAdminAuditService } from './super-admin-audit.service';

import type { Env } from '../../config/env.schema';

interface ImpersonateArgs {
  superAdminId: string;
  tenantId: string;
  reason: string;
  /** Solo lectura: permisos de `readonly` y el API rechaza las escrituras. */
  readOnly?: boolean;
  /** Entrar como este usuario (activo del tenant); sin él, el propietario. */
  userId?: string | undefined;
  /** Sin aviso al propietario (la cuenta de demostración de los comerciales). */
  skipOwnerNotice?: boolean;
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
  private readonly logger = new Logger(ImpersonationService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
    private readonly superAdminAudit: SuperAdminAuditService,
    private readonly email: EmailService,
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
    // Como un usuario concreto: con sus permisos y su alcance por local.
    let asUser: {
      id: string;
      role: UserRole;
      fullName: string;
      permissions: Permission[];
    } | null = null;
    if (args.userId) {
      const u = await this.admin.user.findFirst({
        where: { id: args.userId, tenantId: tenant.id },
        select: {
          id: true,
          role: true,
          isActive: true,
          fullName: true,
          tenantRole: { select: { permissions: true } },
        },
      });
      if (!u) {
        throw new NotFoundException({ code: 'user_not_found', message: 'Usuario no encontrado' });
      }
      if (!u.isActive) {
        throw new BadRequestException({
          code: 'user_inactive',
          message: 'Ese usuario está desactivado.',
        });
      }
      const role = u.role as UserRole;
      asUser = {
        id: u.id,
        role,
        fullName: u.fullName,
        permissions:
          u.tenantRole && role !== 'owner'
            ? (u.tenantRole.permissions as Permission[])
            : permissionsForRole(role),
      };
    }
    const ttl = this.config.get('IMPERSONATION_TTL_SECONDS', { infer: true });
    const expiresAt = new Date(Date.now() + ttl * 1000);

    const log = await this.admin.impersonationLog.create({
      data: {
        superAdminId: args.superAdminId,
        tenantId: args.tenantId,
        reason: args.reason,
        readOnly: args.readOnly ?? false,
        userId: asUser?.id ?? null,
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
    // Sin owner activo (tenant vacío/anonimizado a medias): sub sintético.
    // `JwtStrategy` no encuentra ese usuario y rechaza el token, así que la
    // sesión no sirve; el panel lo dice al abrirla.
    const subject = asUser?.id ?? owner?.id ?? randomUUID();
    const accessToken = await this.jwt.signAsync(
      {
        tenantId: tenant.id,
        // Sin usuario elegido, los permisos del propietario: en solo lectura el
        // soporte ve todo lo que él ve (Suscripción, Configuración…) y es
        // `ImpersonationGuard` quien bloquea cualquier escritura. Con un
        // usuario, sus permisos (y su alcance por local, que `JwtStrategy`
        // lee de la base de datos).
        role: asUser?.role ?? 'owner',
        ...(asUser ? { permissions: asUser.permissions } : {}),
        purpose: 'impersonation',
        superAdminId: args.superAdminId,
        // Ata el JWT a su fila de `ImpersonationLog`: `JwtStrategy` la
        // consulta en cada request para poder cortar la sesión antes de que
        // expire sola (ver `AdminImpersonationAuditService.revoke`).
        impersonationId: log.id,
      },
      {
        subject,
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
        expiresIn: ttl,
      },
    );

    if (!args.readOnly && !args.skipOwnerNotice) {
      void this.notifyOwners(tenant.id, tenant.name, args.reason);
    }

    await this.audit.write({
      tenantId: tenant.id,
      userId: null,
      action: 'admin.impersonation.started',
      entityType: 'Tenant',
      entityId: tenant.id,
      changes: {
        superAdminId: args.superAdminId,
        reason: args.reason,
        readOnly: args.readOnly ?? false,
        expiresAt: expiresAt.toISOString(),
        ...(asUser ? { asUserId: asUser.id } : {}),
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
        readOnly: args.readOnly ?? false,
        expiresAt: expiresAt.toISOString(),
        ...(asUser ? { asUserId: asUser.id, asUserName: asUser.fullName } : {}),
      },
    });

    return {
      accessToken,
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      expiresIn: ttl,
      readOnly: args.readOnly ?? false,
    };
  }

  /** Entrar con permiso para hacer cambios se avisa al propietario. No bloquea la entrada. */
  private async notifyOwners(tenantId: string, tenantName: string, reason: string): Promise<void> {
    try {
      const owners = await this.admin.user.findMany({
        where: { tenantId, role: 'owner', isActive: true },
        select: { email: true },
      });
      const { html, text } = renderAdminEmail(
        [
          `El equipo de soporte de TrasterOS ha entrado en la cuenta de ${tenantName} con permiso para hacer cambios.`,
          `Motivo: ${reason}`,
          'Si no esperabas este acceso, escríbenos desde Soporte en tu panel.',
        ].join('\n\n'),
      );
      for (const owner of owners) {
        await this.email.sendRendered({
          to: owner.email,
          kind: 'admin_message',
          subject: 'El soporte de TrasterOS ha entrado en tu cuenta',
          html,
          text,
        });
      }
    } catch (err) {
      this.logger.warn(`Aviso de impersonación: ${(err as Error).message}`);
    }
  }
}
