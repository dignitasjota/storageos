import { Injectable, Logger } from '@nestjs/common';

import { CryptoService } from '../../common/crypto/crypto.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import {
  type SyncDevice,
  type SyncState,
} from './providers/credential-sync-provider';
import { SyncProviderRegistry } from './providers/sync-provider.registry';

import type { AccessCredential, AccessDevice, AccessMethod, AccessResult } from '@storageos/database';

/** Estado de credencial → estado de sincronización (pending = no se sincroniza). */
function toSyncState(status: string): SyncState | null {
  if (status === 'active') return 'active';
  if (status === 'suspended') return 'suspended';
  if (status === 'revoked') return 'revoked';
  return null; // pending
}

/**
 * Orquestación del Patrón B (sincronización de credenciales a terminales
 * autónomos). Es la lógica NUESTRA (independiente del fabricante): decide qué
 * terminales tocar, propaga altas/estados y reconcilia los registros de acceso
 * hacia `access_logs`. El detalle del protocolo vive en el `CredentialSyncProvider`
 * (Dahua/stub). Todo best-effort: nunca rompe el flujo de credenciales.
 */
@Injectable()
export class DahuaSyncService {
  private readonly logger = new Logger(DahuaSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly crypto: CryptoService,
    private readonly registry: SyncProviderRegistry,
  ) {}

  private toSyncDevice(d: AccessDevice): SyncDevice {
    return {
      id: d.id,
      hardwareId: d.hardwareId,
      channel: Number((d.metadata as { channel?: number } | null)?.channel ?? 1),
      controlUrl: d.controlUrl,
      controlSecret: d.controlSecretEncrypted
        ? this.crypto.decryptString(d.controlSecretEncrypted)
        : null,
    };
  }

  /** Secreto en claro de la credencial (PIN/QR descifrado, o UID RFID). */
  private secretOf(cred: AccessCredential): string | null {
    if (cred.method === ('rfid' as AccessMethod)) return cred.rfidUid;
    if (cred.secretEncrypted) return this.crypto.decryptString(cred.secretEncrypted);
    return null;
  }

  /** Terminales Patrón B en el scope de la credencial (o todos si scope vacío). */
  private async syncableDevices(
    tenantId: string,
    allowedFacilityIds: string[],
  ): Promise<AccessDevice[]> {
    const devices = await this.prisma.withTenant(
      (tx) =>
        tx.accessDevice.findMany({
          where: {
            isActive: true,
            ...(allowedFacilityIds.length > 0 ? { facilityId: { in: allowedFacilityIds } } : {}),
          },
        }),
      tenantId,
    );
    return devices.filter((d) => this.registry.isSyncable(d.provider));
  }

  /** Propaga una credencial a los terminales de su scope (alta/actualización). */
  async syncCredential(tenantId: string, credentialId: string): Promise<void> {
    try {
      const cred = await this.prisma.withTenant(
        (tx) => tx.accessCredential.findFirst({ where: { id: credentialId } }),
        tenantId,
      );
      if (!cred) return;
      const state = toSyncState(cred.status);
      if (!state) return; // pending: aún no se sincroniza
      const secret = this.secretOf(cred);
      if (!secret) return;

      const devices = await this.syncableDevices(tenantId, cred.allowedFacilityIds);
      for (const device of devices) {
        const provider = this.registry.resolve(device.provider);
        if (!provider) continue;
        try {
          const { ref } = await provider.pushCredential(this.toSyncDevice(device), {
            credentialId: cred.id,
            customerId: cred.customerId,
            method: cred.method as 'pin' | 'qr' | 'rfid',
            secret,
            label: cred.label,
            state,
          });
          await this.prisma.withTenant(
            (tx) =>
              tx.accessCredentialSync.upsert({
                where: { credentialId_deviceId: { credentialId: cred.id, deviceId: device.id } },
                create: {
                  tenantId,
                  credentialId: cred.id,
                  deviceId: device.id,
                  hardwareRef: ref,
                  state,
                },
                update: { hardwareRef: ref, state, syncedAt: new Date() },
              }),
            tenantId,
          );
        } catch (err) {
          this.logger.warn(
            `[sync] push credencial ${cred.id} → device ${device.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(
        `[sync] syncCredential ${credentialId} falló: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Propaga un cambio de estado (suspender/reactivar/revocar) a los terminales. */
  async applyState(tenantId: string, credentialId: string, state: SyncState): Promise<void> {
    try {
      const rows = await this.prisma.withTenant(
        (tx) =>
          tx.accessCredentialSync.findMany({
            where: { credentialId },
            include: { device: true },
          }),
        tenantId,
      );
      for (const row of rows) {
        const provider = this.registry.resolve(row.device.provider);
        if (!provider) continue;
        const dev = this.toSyncDevice(row.device);
        try {
          if (state === 'revoked') {
            await provider.remove(dev, row.hardwareRef);
            await this.prisma.withTenant(
              (tx) => tx.accessCredentialSync.delete({ where: { id: row.id } }),
              tenantId,
            );
          } else {
            await provider.setState(dev, row.hardwareRef, state);
            await this.prisma.withTenant(
              (tx) => tx.accessCredentialSync.update({ where: { id: row.id }, data: { state } }),
              tenantId,
            );
          }
        } catch (err) {
          this.logger.warn(
            `[sync] applyState ${credentialId}/${row.device.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(
        `[sync] applyState ${credentialId} falló: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Reconcilia los registros de acceso de un terminal → `access_logs`. */
  async reconcileDevice(tenantId: string, deviceId: string): Promise<{ imported: number }> {
    const device = await this.prisma.withTenant(
      (tx) => tx.accessDevice.findFirst({ where: { id: deviceId } }),
      tenantId,
    );
    if (!device) return { imported: 0 };
    const provider = this.registry.resolve(device.provider);
    if (!provider) return { imported: 0 };

    const events = await provider.pullEvents(this.toSyncDevice(device), device.lastReconciledAt);
    let imported = 0;
    let maxTs = device.lastReconciledAt?.getTime() ?? 0;
    for (const ev of events) {
      // Resuelve la credencial por el ref del hardware (best-effort).
      const sync = ev.credentialRef
        ? await this.prisma.withTenant(
            (tx) =>
              tx.accessCredentialSync.findFirst({
                where: { deviceId, hardwareRef: ev.credentialRef as string },
                select: { credentialId: true },
              }),
            tenantId,
          )
        : null;
      await this.prisma.withTenant(
        (tx) =>
          tx.accessLog.create({
            data: {
              tenantId,
              deviceId,
              credentialId: sync?.credentialId ?? null,
              method: ev.method as AccessMethod,
              result: (ev.allowed ? 'allowed' : 'denied_invalid_credential') as AccessResult,
              reason: 'reconciled_from_device',
              metadata: { offline: true, ...(ev.raw ?? {}) },
              occurredAt: ev.occurredAt,
            },
          }),
        tenantId,
      );
      imported += 1;
      maxTs = Math.max(maxTs, ev.occurredAt.getTime());
    }
    await this.prisma.withTenant(
      (tx) =>
        tx.accessDevice.update({
          where: { id: deviceId },
          data: { lastReconciledAt: new Date(Math.max(maxTs, Date.now() - 1)) },
        }),
      tenantId,
    );
    return { imported };
  }

  /** Cron cross-tenant: reconcilia todos los terminales Patrón B. */
  async reconcileAllDue(): Promise<{ devices: number; imported: number }> {
    const devices = await this.admin.accessDevice.findMany({
      where: { isActive: true, provider: { in: ['dahua', 'stub'] } },
      select: { id: true, tenantId: true },
      take: 2000,
    });
    let imported = 0;
    for (const d of devices) {
      try {
        const r = await this.reconcileDevice(d.tenantId, d.id);
        imported += r.imported;
      } catch (err) {
        this.logger.warn(
          `[sync] reconcile device ${d.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { devices: devices.length, imported };
  }
}
