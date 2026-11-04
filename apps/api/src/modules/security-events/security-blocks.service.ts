import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';

import { SecurityEventsService } from './security-events.service';

import type { CreateSecurityBlockInput, SecurityBlockDto } from '@storageos/shared';

/**
 * Bloqueo manual de una IP o un email en las entradas al panel del equipo y al
 * panel admin. Quien está bloqueado ve el mismo error que con una contraseña
 * mala, y el intento queda en los eventos de seguridad.
 */
@Injectable()
export class SecurityBlocksService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly events: SecurityEventsService,
  ) {}

  async assertAllowed(args: {
    email: string;
    ipAddress?: string | null | undefined;
    userAgent?: string | null | undefined;
  }): Promise<void> {
    const email = args.email.trim().toLowerCase();
    const block = await this.admin.securityBlock.findFirst({
      where: {
        OR: [
          { kind: 'email', value: email },
          ...(args.ipAddress ? [{ kind: 'ip', value: args.ipAddress }] : []),
        ],
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }],
      },
    });
    if (!block) return;
    await this.events.record({
      eventType: 'login_blocked',
      emailAttempted: email,
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
      reason: block.kind,
    });
    throw new UnauthorizedException('Credenciales invalidas');
  }

  async list(): Promise<SecurityBlockDto[]> {
    const rows = await this.admin.securityBlock.findMany({
      where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      include: { createdBy: { select: { fullName: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as SecurityBlockDto['kind'],
      value: r.value,
      reason: r.reason,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      createdByName: r.createdBy?.fullName ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** Nadie se bloquea a sí mismo ni a un super admin activo: se quedaría fuera. */
  async create(
    input: CreateSecurityBlockInput,
    actor: { id: string; ipAddress?: string | undefined },
  ): Promise<void> {
    const value = input.value;
    const isAdminEmail =
      input.kind === 'email' &&
      (await this.admin.superAdmin.count({ where: { email: value, isActive: true } })) > 0;
    if (isAdminEmail || (input.kind === 'ip' && value === actor.ipAddress)) {
      throw new BadRequestException({
        code: 'cannot_block_self',
        message: 'No se puede bloquear tu IP ni el email de un super admin',
      });
    }
    const expiresAt = input.expiresInHours
      ? new Date(Date.now() + input.expiresInHours * 3_600_000)
      : null;
    const data = { reason: input.reason ?? null, expiresAt, createdById: actor.id };
    await this.admin.securityBlock.upsert({
      where: { kind_value: { kind: input.kind, value } },
      create: { kind: input.kind, value, ...data },
      update: data,
    });
  }

  async remove(id: string): Promise<void> {
    const { count } = await this.admin.securityBlock.deleteMany({ where: { id } });
    if (count === 0) {
      throw new NotFoundException({ code: 'block_not_found', message: 'Bloqueo no encontrado' });
    }
  }

  async removeExpired(): Promise<void> {
    await this.admin.securityBlock.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  }
}
