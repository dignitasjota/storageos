/**
 * Provider abstracto para abrir/cerrar cerraduras fisicas. Igual patron
 * que EmailProvider/WhatsAppProvider/PaymentGateway: clase abstracta + DI
 * por Symbol + factory en el modulo.
 *
 * Implementaciones Fase 7:
 *   - StubLockProvider: solo loggea. Usado en dev/test cuando no hay
 *     hardware. La verificacion HTTP/MQTT igualmente registra en BD.
 *   - MqttLockProvider: publica comandos `open` en el broker y se
 *     suscribe a topics de heartbeat de los devices.
 */
export abstract class LockProvider {
  abstract get name(): string;
  /** Envia comando "abrir" al device. Async porque MQTT tarda en publish + ack. */
  abstract open(args: OpenLockArgs): Promise<OpenLockResult>;
  /** Conexion inicial. Llamado en onModuleInit. */
  abstract start?(): Promise<void>;
  /** Cierre limpio. Llamado en onModuleDestroy. */
  abstract stop?(): Promise<void>;
}

export interface OpenLockArgs {
  tenantId: string;
  /** Device id (UUID) o hardwareId. */
  deviceId: string;
  /** Topic MQTT si el provider lo necesita. */
  mqttTopic?: string | null;
  /** Customer id (para logging del provider, opcional). */
  customerId?: string;
}

export interface OpenLockResult {
  /** true si el provider acepto el comando; false si fallo (red, timeout). */
  dispatched: boolean;
  message?: string;
}

export const LOCK_PROVIDER = Symbol('LockProvider');
