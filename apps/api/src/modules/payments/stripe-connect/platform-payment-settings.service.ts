import { Injectable } from '@nestjs/common';

import { PrismaAdminService } from '../../database/prisma-admin.service';

import type {
  PlatformPaymentSettingsDto,
  UpdatePlatformPaymentSettingsInput,
} from '@storageos/shared';

/** Comisión de la plataforma sobre los cobros de Stripe de los tenants. */
@Injectable()
export class PlatformPaymentSettingsService {
  constructor(private readonly admin: PrismaAdminService) {}

  private async row() {
    return (
      (await this.admin.platformPaymentSettings.findFirst()) ??
      (await this.admin.platformPaymentSettings.create({ data: {} }))
    );
  }

  async applicationFeePct(): Promise<number> {
    return Number((await this.row()).applicationFeePct);
  }

  async get(): Promise<PlatformPaymentSettingsDto> {
    const [row, connectedTenants] = await Promise.all([
      this.row(),
      this.admin.tenantStripeAccount.count({ where: { chargesEnabled: true } }),
    ]);
    return { applicationFeePct: Number(row.applicationFeePct), connectedTenants };
  }

  async update(input: UpdatePlatformPaymentSettingsInput): Promise<PlatformPaymentSettingsDto> {
    const row = await this.row();
    await this.admin.platformPaymentSettings.update({
      where: { id: row.id },
      data: { applicationFeePct: input.applicationFeePct },
    });
    return this.get();
  }
}
