import { BadRequestException, Injectable } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type {
  PlatformSecuritySettingsDto,
  UpdatePlatformSecuritySettingsInput,
} from '@storageos/shared';

/** Política de acceso al panel admin: de momento, la 2FA obligatoria. */
@Injectable()
export class PlatformSecurityService {
  constructor(private readonly admin: PrismaAdminService) {}

  async get(): Promise<PlatformSecuritySettingsDto> {
    const [row, adminsWithoutTwoFactor] = await Promise.all([
      this.admin.platformSecuritySettings.findFirst(),
      this.admin.superAdmin.count({ where: { isActive: true, twoFactorEnabled: false } }),
    ]);
    return {
      requireAdminTwoFactor: row?.requireAdminTwoFactor ?? false,
      adminTwoFactorGraceDays: row?.adminTwoFactorGraceDays ?? 7,
      adminTwoFactorRequiredSince: row?.adminTwoFactorRequiredSince?.toISOString() ?? null,
      adminsWithoutTwoFactor,
    };
  }

  /** Quien la activa debe tenerla: si no, se dejaría fuera a sí mismo. */
  async update(
    actorId: string,
    input: UpdatePlatformSecuritySettingsInput,
  ): Promise<PlatformSecuritySettingsDto> {
    const row = await this.admin.platformSecuritySettings.findFirst();
    const turningOn = input.requireAdminTwoFactor && !row?.requireAdminTwoFactor;
    if (turningOn) {
      const actor = await this.admin.superAdmin.findUniqueOrThrow({
        where: { id: actorId },
        select: { twoFactorEnabled: true },
      });
      if (!actor.twoFactorEnabled) {
        throw new BadRequestException({
          code: 'own_two_factor_required',
          message: 'Activa antes tu verificación en dos pasos',
        });
      }
    }
    const data = {
      requireAdminTwoFactor: input.requireAdminTwoFactor,
      adminTwoFactorGraceDays: input.adminTwoFactorGraceDays,
      adminTwoFactorRequiredSince: !input.requireAdminTwoFactor
        ? null
        : turningOn
          ? new Date()
          : (row?.adminTwoFactorRequiredSince ?? new Date()),
    };
    if (row) {
      await this.admin.platformSecuritySettings.update({ where: { id: row.id }, data });
    } else {
      await this.admin.platformSecuritySettings.create({ data });
    }
    return this.get();
  }
}
