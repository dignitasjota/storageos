import { Injectable } from '@nestjs/common';
import {
  DEFAULT_HEALTH_CLIENT_WEIGHTS,
  DEFAULT_HEALTH_TRIAL_WEIGHTS,
  parseHealthWeights,
  type AdminPlatformHealthSettingsDto,
  type UpdatePlatformHealthSettingsInput,
} from '@storageos/shared';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type { Prisma } from '@storageos/database';

/**
 * Ajustes de Salud y Uso (un solo registro): pesos de los factores de salud de
 * clientes y de activación de pruebas, puntos de caída que disparan el aviso y
 * umbrales del consumo anómalo. Leer lo pueden todos los del panel; cambiarlo,
 * solo el rol superadmin.
 */
@Injectable()
export class PlatformHealthSettingsService {
  constructor(private readonly admin: PrismaAdminService) {}

  private async row() {
    const existing = await this.admin.platformHealthSettings.findFirst();
    if (existing) return existing;
    return this.admin.platformHealthSettings.create({
      data: {
        clientWeights: DEFAULT_HEALTH_CLIENT_WEIGHTS,
        trialWeights: DEFAULT_HEALTH_TRIAL_WEIGHTS,
      },
    });
  }

  async get(): Promise<AdminPlatformHealthSettingsDto> {
    const r = await this.row();
    return {
      clientWeights: parseHealthWeights(r.clientWeights, DEFAULT_HEALTH_CLIENT_WEIGHTS),
      trialWeights: parseHealthWeights(r.trialWeights, DEFAULT_HEALTH_TRIAL_WEIGHTS),
      dropAlertPoints: r.dropAlertPoints,
      anomalyMultiplier: Number(r.anomalyMultiplier),
      anomalyMinEmails: r.anomalyMinEmails,
      anomalyMinAiUsd: Number(r.anomalyMinAiUsd),
      anomalyMinStorageMb: r.anomalyMinStorageMb,
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  async update(input: UpdatePlatformHealthSettingsInput): Promise<AdminPlatformHealthSettingsDto> {
    const r = await this.row();
    const data: Prisma.PlatformHealthSettingsUpdateInput = {};
    if (input.clientWeights) data.clientWeights = input.clientWeights;
    if (input.trialWeights) data.trialWeights = input.trialWeights;
    if (input.dropAlertPoints !== undefined) data.dropAlertPoints = input.dropAlertPoints;
    if (input.anomalyMultiplier !== undefined) data.anomalyMultiplier = input.anomalyMultiplier;
    if (input.anomalyMinEmails !== undefined) data.anomalyMinEmails = input.anomalyMinEmails;
    if (input.anomalyMinAiUsd !== undefined) data.anomalyMinAiUsd = input.anomalyMinAiUsd;
    if (input.anomalyMinStorageMb !== undefined) {
      data.anomalyMinStorageMb = input.anomalyMinStorageMb;
    }
    await this.admin.platformHealthSettings.update({ where: { id: r.id }, data });
    return this.get();
  }
}
