/**
 * Provider de SINCRONIZACIÓN de credenciales (Patrón B / offline). Distinto del
 * `LockProvider` (que solo abre): aquí sincronizamos las credenciales AL terminal
 * para que valide él solo (funciona sin red), cortamos por impago cambiando su
 * estado, y reconciliamos sus registros de acceso hacia `access_logs`.
 *
 * Lo implementan solo los terminales autónomos (Dahua ASI, ZKTeco…). Los
 * providers de Patrón A puro (http/mqtt/stub-lock) NO sincronizan → el registry
 * devuelve `null` para ellos.
 */
export type SyncState = 'active' | 'suspended' | 'revoked';

/** Dispositivo destino de la sincronización (datos ya descifrados). */
export interface SyncDevice {
  id: string;
  hardwareId: string;
  channel: number;
  /** Base del terminal (`http://<ip>`). */
  controlUrl: string | null;
  /** Credenciales del terminal en formato `user:pass` (descifradas). */
  controlSecret: string | null;
  /** Zona horaria del local (las fechas de validez van en hora local del terminal). */
  timezone: string;
}

/** Credencial a sincronizar (secreto en claro para escribirlo en el terminal). */
export interface SyncCredentialSpec {
  credentialId: string;
  customerId: string;
  method: 'pin' | 'qr' | 'rfid';
  /** PIN / token QR / UID RFID en claro. */
  secret: string;
  label: string | null;
  state: SyncState;
  /** Caducidad de la credencial (pase nocturno, accesos temporales) o null. */
  validUntil: Date | null;
  /** Límite de usos (pase single-use) o null = ilimitado. */
  maxUses: number | null;
}

/** Registro de acceso leído del terminal (para reconciliar a `access_logs`). */
export interface SyncAccessEvent {
  occurredAt: Date;
  /** Ref del hardware (CardNo/recno) si el terminal lo reporta. */
  credentialRef: string | null;
  method: 'pin' | 'qr' | 'rfid';
  allowed: boolean;
  raw?: Record<string, unknown>;
}

export abstract class CredentialSyncProvider {
  abstract get name(): string;
  /** Alta/actualización de la credencial en el terminal → ref del hardware. */
  abstract pushCredential(device: SyncDevice, cred: SyncCredentialSpec): Promise<{ ref: string }>;
  /** Cambia el estado (activo/suspendido) de una credencial ya sincronizada. */
  abstract setState(device: SyncDevice, ref: string, state: SyncState): Promise<void>;
  /** Baja definitiva de la credencial en el terminal. */
  abstract remove(device: SyncDevice, ref: string): Promise<void>;
  /** Lee los registros de acceso del terminal desde `since` (o todos si null). */
  abstract pullEvents(device: SyncDevice, since: Date | null): Promise<SyncAccessEvent[]>;
}
