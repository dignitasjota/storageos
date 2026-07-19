import { Injectable } from '@nestjs/common';

import {
  CredentialSyncProvider,
  type SyncAccessEvent,
  type SyncCredentialSpec,
  type SyncDevice,
  type SyncState,
} from './credential-sync-provider';

interface StubEntry {
  ref: string;
  state: SyncState;
  method: 'pin' | 'qr' | 'rfid' | 'face';
  credentialId: string;
  validUntil: Date | null;
  maxUses: number | null;
  /** Solo facial: indica que se recibió la plantilla (foto). */
  hasFace: boolean;
}

/**
 * Provider de sincronización EN MEMORIA para dev/test/CI (sin hardware). Simula
 * un terminal Patrón B: guarda las credenciales sincronizadas y su estado, y
 * permite encolar eventos de acceso para probar la reconciliación. Los tests lo
 * inspeccionan vía `app.get(StubSyncProvider)`.
 */
@Injectable()
export class StubSyncProvider extends CredentialSyncProvider {
  /** deviceId → (credentialId → entry). */
  private readonly store = new Map<string, Map<string, StubEntry>>();
  /** deviceId → eventos pendientes de reconciliar. */
  private readonly pending = new Map<string, SyncAccessEvent[]>();
  private counter = 0;

  get name(): string {
    return 'stub-sync';
  }

  private deviceMap(deviceId: string): Map<string, StubEntry> {
    let m = this.store.get(deviceId);
    if (!m) {
      m = new Map();
      this.store.set(deviceId, m);
    }
    return m;
  }

  async pushCredential(device: SyncDevice, cred: SyncCredentialSpec): Promise<{ ref: string }> {
    const m = this.deviceMap(device.id);
    const existing = m.get(cred.credentialId);
    const ref = existing?.ref ?? `stub-${(this.counter += 1)}`;
    m.set(cred.credentialId, {
      ref,
      state: cred.state,
      method: cred.method,
      credentialId: cred.credentialId,
      validUntil: cred.validUntil,
      maxUses: cred.maxUses,
      hasFace: cred.method === 'face' && !!cred.photoBase64,
    });
    return { ref };
  }

  async setState(device: SyncDevice, ref: string, state: SyncState): Promise<void> {
    for (const entry of this.deviceMap(device.id).values()) {
      if (entry.ref === ref) entry.state = state;
    }
  }

  async remove(device: SyncDevice, ref: string): Promise<void> {
    const m = this.deviceMap(device.id);
    for (const [key, entry] of m) {
      if (entry.ref === ref) m.delete(key);
    }
  }

  async pullEvents(device: SyncDevice): Promise<SyncAccessEvent[]> {
    const evs = this.pending.get(device.id) ?? [];
    this.pending.set(device.id, []);
    return evs;
  }

  // ---- helpers de test ----

  /** Estado de una credencial en un device (undefined si no sincronizada). */
  stateOf(deviceId: string, credentialId: string): SyncState | undefined {
    return this.store.get(deviceId)?.get(credentialId)?.state;
  }

  /** Encola un evento de acceso para que la reconciliación lo recoja. */
  queueEvent(deviceId: string, ev: SyncAccessEvent): void {
    const arr = this.pending.get(deviceId) ?? [];
    arr.push(ev);
    this.pending.set(deviceId, arr);
  }

  reset(): void {
    this.store.clear();
    this.pending.clear();
    this.counter = 0;
  }
}
