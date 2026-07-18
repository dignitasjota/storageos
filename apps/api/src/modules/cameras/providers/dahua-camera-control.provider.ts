import { Injectable, Logger } from '@nestjs/common';

import {
  CameraControlProvider,
  type CameraControlDevice,
  type CameraControlResult,
} from './camera-control-provider';

/**
 * Acciones salientes contra cámaras/NVR **Dahua**. SCAFFOLD: la estructura está
 * completa, pero los cuerpos reales necesitan el equipo para verificarse:
 *   - `snapshot`: `GET <controlUrl>/cgi-bin/snapshot.cgi?channel=N` con Digest
 *     devuelve el JPEG binario (nuestro `digest-fetch` hoy lee texto, no bytes →
 *     el binario se completa con el agente on-site o ampliando digest-fetch).
 *   - `arm`/`disarm`: el CGI de armado no está en la doc pública de accesos;
 *     depende del NVR/AirShield → `VERIFY` con hardware.
 *
 * Sin la ruta de red al equipo (agente on-site / LAN), estas acciones devuelven
 * `dispatched:false` con el motivo, sin romper nada (mismo contrato que el
 * `LockProvider`). La ingesta de eventos NO depende de esto.
 */
@Injectable()
export class DahuaCameraControlProvider extends CameraControlProvider {
  private readonly logger = new Logger(DahuaCameraControlProvider.name);

  get name(): string {
    return 'dahua-camera';
  }

  private notConfigured(device: CameraControlDevice): CameraControlResult | null {
    if (!device.controlUrl) return { dispatched: false, message: 'device_sin_control_url' };
    if (!device.controlSecret?.includes(':')) {
      return { dispatched: false, message: 'device_sin_credenciales' };
    }
    return null;
  }

  async snapshot(device: CameraControlDevice): Promise<CameraControlResult> {
    const bad = this.notConfigured(device);
    if (bad) return bad;
    // URL correcta: `${controlUrl}/cgi-bin/snapshot.cgi?channel=${device.channel}`
    // con Digest. Pendiente: leer el cuerpo BINARIO (digest-fetch lee texto) →
    // requiere agente on-site o ampliar digest-fetch. VERIFY con hardware.
    this.logger.debug(`[dahua-camera] snapshot ${device.id} pendiente de agente on-site`);
    return { dispatched: false, message: 'snapshot_requiere_agente_on_site' };
  }

  async arm(device: CameraControlDevice): Promise<CameraControlResult> {
    const bad = this.notConfigured(device);
    if (bad) return bad;
    return { dispatched: false, message: 'armar_requiere_nvr' };
  }

  async disarm(device: CameraControlDevice): Promise<CameraControlResult> {
    const bad = this.notConfigured(device);
    if (bad) return bad;
    return { dispatched: false, message: 'desarmar_requiere_nvr' };
  }
}
