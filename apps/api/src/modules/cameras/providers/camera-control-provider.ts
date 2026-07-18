/**
 * Puerto de ACCIONES SALIENTES sobre un equipo de cámara/alarma (snapshot bajo
 * demanda, armar/desarmar). Distinto de la ingesta de eventos (entrante, por
 * webhook): aquí NOSOTROS hablamos con el equipo, así que sí depende del
 * fabricante → se resuelve por device (`camera_devices.provider`), como el
 * `LockProvider` de accesos.
 *
 * La ingesta seguirá funcionando aunque estas acciones no estén disponibles
 * (equipo sin `controlUrl`, sin agente on-site, provider `generic`).
 */
export interface CameraControlDevice {
  id: string;
  channel: number;
  /** Base del equipo/NVR (`http://<ip>`) o null si no está configurado. */
  controlUrl: string | null;
  /** Credenciales `user:pass` del equipo (ya descifradas) o null. */
  controlSecret: string | null;
}

export interface CameraControlResult {
  /** El comando se envió al equipo (no garantiza el efecto físico). */
  dispatched: boolean;
  /** Motivo cuando `dispatched:false`. */
  message?: string;
  /** JPEG en base64 devuelto por la cámara (solo en `snapshot`). */
  jpegBase64?: string;
  /** MIME del snapshot (default image/jpeg). */
  mimeType?: 'image/jpeg' | 'image/png';
}

export abstract class CameraControlProvider {
  abstract get name(): string;
  /** Captura un fotograma bajo demanda. */
  abstract snapshot(device: CameraControlDevice): Promise<CameraControlResult>;
  /** Arma la alarma del equipo/NVR. */
  abstract arm(device: CameraControlDevice): Promise<CameraControlResult>;
  /** Desarma la alarma del equipo/NVR. */
  abstract disarm(device: CameraControlDevice): Promise<CameraControlResult>;
}
