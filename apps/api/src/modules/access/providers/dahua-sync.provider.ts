import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import {
  CredentialSyncProvider,
  type SyncAccessEvent,
  type SyncCredentialSpec,
  type SyncDevice,
  type SyncState,
} from './credential-sync-provider';
import { digestRequest } from './digest-fetch';

/**
 * Sincronización de credenciales contra terminales **Dahua** (serie ASI…) por
 * `recordUpdater.cgi` / `recordFinder.cgi` con Digest (Patrón B).
 *
 * ⚠️ SCAFFOLD: los NOMBRES DE CAMPO exactos de `AccessControlCard` /
 * `AccessControlCardRec` y el mapeo de `CardStatus` dependen del firmware — están
 * marcados con `VERIFY` y deben confirmarse con la doc "HTTP API for Access
 * Control" del modelo (ver `docs/HARDWARE_DAHUA.md`). La orquestación
 * (`DahuaSyncService`) es independiente de esto y se prueba con `StubSyncProvider`.
 */
@Injectable()
export class DahuaSyncProvider extends CredentialSyncProvider {
  private readonly logger = new Logger(DahuaSyncProvider.name);

  get name(): string {
    return 'dahua-sync';
  }

  /** Estado nuestro → `CardStatus` de Dahua (VERIFY con el firmware). */
  private cardStatus(state: SyncState): number {
    if (state === 'suspended') return 8; // Arrearage (impago)
    if (state === 'revoked') return 2; // Canceled
    return 0; // Normal
  }

  /** CardNo determinista a partir de nuestro credentialId (numérico, 10 díg). */
  private cardNo(credentialId: string): string {
    const h = createHash('sha1').update(credentialId).digest('hex').slice(0, 8);
    return (parseInt(h, 16) % 1_000_000_0000).toString();
  }

  private creds(device: SyncDevice): { user: string; pass: string } | null {
    if (!device.controlUrl || !device.controlSecret?.includes(':')) return null;
    const [user, ...rest] = device.controlSecret.split(':');
    return { user: user as string, pass: rest.join(':') };
  }

  async pushCredential(device: SyncDevice, cred: SyncCredentialSpec): Promise<{ ref: string }> {
    const c = this.creds(device);
    const cardNo = this.cardNo(cred.credentialId);
    if (!c || !device.controlUrl) return { ref: cardNo };
    // VERIFY: nombres de campo de AccessControlCard (CardNo/UserID/CardName/
    // CardStatus/CardType) + cómo asociar el PIN/RFID a la credencial.
    const params = new URLSearchParams({
      action: 'insert',
      name: 'AccessControlCard',
      CardNo: cardNo,
      UserID: cred.customerId.replace(/-/g, '').slice(0, 20),
      CardName: (cred.label ?? cred.customerId).slice(0, 32),
      CardStatus: String(this.cardStatus(cred.state)),
      CardType: '0',
    });
    const res = await digestRequest({
      url: `${device.controlUrl.replace(/\/+$/, '')}/cgi-bin/recordUpdater.cgi?${params}`,
      username: c.user,
      password: c.pass,
    });
    if (!res.ok) this.logger.warn(`[dahua-sync] push ${device.hardwareId} → ${res.status}`);
    return { ref: cardNo };
  }

  async setState(device: SyncDevice, ref: string, state: SyncState): Promise<void> {
    const c = this.creds(device);
    if (!c || !device.controlUrl) return;
    // VERIFY: update por CardNo o por recno según firmware.
    const params = new URLSearchParams({
      action: 'update',
      name: 'AccessControlCard',
      CardNo: ref,
      CardStatus: String(this.cardStatus(state)),
    });
    const res = await digestRequest({
      url: `${device.controlUrl.replace(/\/+$/, '')}/cgi-bin/recordUpdater.cgi?${params}`,
      username: c.user,
      password: c.pass,
    });
    if (!res.ok) this.logger.warn(`[dahua-sync] setState ${device.hardwareId} → ${res.status}`);
  }

  async remove(device: SyncDevice, ref: string): Promise<void> {
    const c = this.creds(device);
    if (!c || !device.controlUrl) return;
    const params = new URLSearchParams({
      action: 'remove',
      name: 'AccessControlCard',
      CardNo: ref,
    });
    const res = await digestRequest({
      url: `${device.controlUrl.replace(/\/+$/, '')}/cgi-bin/recordUpdater.cgi?${params}`,
      username: c.user,
      password: c.pass,
    });
    if (!res.ok) this.logger.warn(`[dahua-sync] remove ${device.hardwareId} → ${res.status}`);
  }

  async pullEvents(device: SyncDevice, since: Date | null): Promise<SyncAccessEvent[]> {
    const c = this.creds(device);
    if (!c || !device.controlUrl) return [];
    const startTime = Math.floor((since?.getTime() ?? 0) / 1000);
    const endTime = Math.floor(Date.now() / 1000);
    const params = new URLSearchParams({
      action: 'find',
      name: 'AccessControlCardRec',
      StartTime: String(startTime),
      EndTime: String(endTime),
      count: '1024',
    });
    const res = await digestRequest({
      url: `${device.controlUrl.replace(/\/+$/, '')}/cgi-bin/recordFinder.cgi?${params}`,
      username: c.user,
      password: c.pass,
    });
    if (!res.ok) {
      this.logger.warn(`[dahua-sync] pullEvents ${device.hardwareId} → ${res.status}`);
      return [];
    }
    // VERIFY: parseo del cuerpo de recordFinder (records[i].CardNo / CreateTime /
    // Status). Formato dependiente del firmware → se completa con la doc real.
    return [];
  }
}
