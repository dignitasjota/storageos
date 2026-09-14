import { randomBytes } from 'node:crypto';

import { BadRequestException, Injectable } from '@nestjs/common';

import { CryptoService } from '../../../common/crypto/crypto.service';
import { PrismaAdminService } from '../../database/prisma-admin.service';

import type { CreatePlatformSepaMandateInput, PlatformSepaMandateDto } from '@storageos/shared';

function rand(n = 8): string {
  return randomBytes(n).toString('hex').toUpperCase().slice(0, n);
}

/**
 * Mandato SEPA por el que un TENANT autoriza a la plataforma a domiciliar su
 * cuota de suscripción en su propia cuenta (el tenant es el deudor). Espejo
 * de `SepaService` (sección mandatos) pero sin RLS — es una tabla de
 * plataforma, scopeada por `tenantId` explícito en cada query, igual que
 * `TenantSubscriptionAddon`/`TenantSubscriptionPayment`.
 *
 * Autoservicio: solo el propio tenant crea/reemplaza su mandato. El admin
 * solo puede leer/cancelar (soporte) — nunca crear en su nombre.
 */
@Injectable()
export class PlatformSepaMandateService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly crypto: CryptoService,
  ) {}

  private toDto(m: {
    id: string;
    tenantId: string;
    reference: string;
    ibanLast4: string;
    bic: string | null;
    signedAt: Date;
    sequenceType: string;
    status: string;
    createdAt: Date;
  }): PlatformSepaMandateDto {
    return {
      id: m.id,
      tenantId: m.tenantId,
      reference: m.reference,
      ibanLast4: m.ibanLast4,
      bic: m.bic,
      signedAt: m.signedAt.toISOString().slice(0, 10),
      sequenceType: m.sequenceType as 'FRST' | 'RCUR',
      status: m.status as 'active' | 'cancelled',
      createdAt: m.createdAt.toISOString(),
    };
  }

  async getMandate(tenantId: string): Promise<PlatformSepaMandateDto | null> {
    const row = await this.admin.platformSepaMandate.findFirst({
      where: { tenantId, status: 'active' },
      orderBy: { createdAt: 'desc' },
    });
    return row ? this.toDto(row) : null;
  }

  async hasActiveMandate(tenantId: string): Promise<boolean> {
    const row = await this.admin.platformSepaMandate.findFirst({
      where: { tenantId, status: 'active' },
      select: { id: true },
    });
    return row !== null;
  }

  /** Alta/reemplazo del mandato (autoservicio del propio tenant). */
  async createMandate(
    tenantId: string,
    input: CreatePlatformSepaMandateInput,
  ): Promise<PlatformSepaMandateDto> {
    const reference = `MND-${rand(12)}`;
    // Solo un mandato activo por tenant: cancela el anterior si lo hay.
    await this.admin.platformSepaMandate.updateMany({
      where: { tenantId, status: 'active' },
      data: { status: 'cancelled' },
    });
    const created = await this.admin.platformSepaMandate.create({
      data: {
        tenantId,
        reference,
        ibanEncrypted: this.crypto.encryptString(input.iban, tenantId),
        ibanLast4: input.iban.slice(-4),
        bic: input.bic || null,
        signedAt: new Date(`${input.signedAt}T00:00:00Z`),
        sequenceType: 'FRST',
        status: 'active',
      },
    });
    return this.toDto(created);
  }

  /**
   * Cancela el mandato activo del tenant. Bloqueado mientras el modo de
   * cobro vigente sea 'sepa' — el tenant no puede quedarse sin mandato
   * siendo ese su método activo (debe pasar a manual/stripe primero).
   */
  async cancelMandate(tenantId: string): Promise<void> {
    const sub = await this.admin.tenantSubscription.findUnique({
      where: { tenantId },
      select: { billingMode: true },
    });
    if (sub?.billingMode === 'sepa') {
      throw new BadRequestException({
        code: 'mode_requires_mandate',
        message: 'No puedes cancelar el mandato mientras el cobro está en modo SEPA',
      });
    }
    await this.admin.platformSepaMandate.updateMany({
      where: { tenantId, status: 'active' },
      data: { status: 'cancelled' },
    });
  }
}
