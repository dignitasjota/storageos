import { Injectable, Logger } from '@nestjs/common';

import { digestRequest } from './digest-fetch';
import { LockProvider, type OpenLockArgs, type OpenLockResult } from './lock-provider';

const TIMEOUT_MS = 8_000;

/**
 * Provider de apertura para terminales de control de accesos **Dahua** (serie
 * ASI…). Abre la puerta con el CGI `accessControl.cgi?action=openDoor`
 * directo contra el terminal en la LAN, autenticado por **Digest**.
 *
 * Encaje con nuestro modelo (Patrón A — apertura remota):
 *   - `controlUrl` del device = base del terminal, `http://<ip>`.
 *   - `controlSecret` (descifrado por el caller) = credenciales Digest en
 *     formato `user:pass`.
 *   - `channel`/puerta: se lee de `access_devices.metadata.channel` (default 1);
 *     hoy `OpenLockArgs` no lo transporta → v1 usa 1. (Multi-puerta por terminal
 *     = follow-up: añadir `door` a `OpenLockArgs` y leer el metadata.)
 *
 * NO lanza: ante fallo de red/timeout/no configurado devuelve `dispatched:false`
 * con el motivo, igual que `HttpLockProvider`. La validación de la credencial la
 * hace el propio terminal (Patrón B) o nuestro backend antes de llamar aquí; este
 * provider solo dispara la apertura.
 */
@Injectable()
export class DahuaLockProvider extends LockProvider {
  private readonly logger = new Logger(DahuaLockProvider.name);

  get name(): string {
    return 'dahua';
  }

  async open(args: OpenLockArgs): Promise<OpenLockResult> {
    return this.sendCommand(args, 'openDoor');
  }

  /** Cierre remoto / lockdown (echa el cerrojo del terminal). */
  override async close(args: OpenLockArgs): Promise<OpenLockResult> {
    return this.sendCommand(args, 'closeDoor');
  }

  private async sendCommand(
    args: OpenLockArgs,
    action: 'openDoor' | 'closeDoor',
  ): Promise<OpenLockResult> {
    if (!args.controlUrl) {
      return { dispatched: false, message: 'device_sin_control_url' };
    }
    if (!args.controlSecret || !args.controlSecret.includes(':')) {
      return { dispatched: false, message: 'device_sin_credenciales_digest' };
    }
    const [username, ...rest] = args.controlSecret.split(':');
    const password = rest.join(':');

    const base = args.controlUrl.replace(/\/+$/, '');
    const channel = 1;
    const url = `${base}/cgi-bin/accessControl.cgi?action=${action}&channel=${channel}&Type=Remote`;

    const res = await digestRequest({
      url,
      method: 'GET',
      username: username as string,
      password,
      timeoutMs: TIMEOUT_MS,
    });
    if (res.ok) return { dispatched: true };
    this.logger.warn(`[dahua-lock] ${action} ${base} → status ${res.status}`);
    return { dispatched: false, message: `dahua_${res.status}` };
  }

  async start(): Promise<void> {
    // Sin conexión persistente: cada apertura es una request Digest independiente.
  }

  async stop(): Promise<void> {
    // Nada que cerrar.
  }
}
