import { Injectable } from '@nestjs/common';

import {
  CameraControlProvider,
  type CameraControlDevice,
  type CameraControlResult,
} from './camera-control-provider';

/** JPEG 1x1 mínimo válido (base64) — snapshot simulado para dev/test. */
const STUB_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof' +
  'Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB' +
  'AAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8AH//Z';

/**
 * Provider de acciones salientes EN MEMORIA (dev/test/CI, sin hardware). El
 * snapshot devuelve un JPEG dummy → permite probar el flujo completo (capturar →
 * guardar en MinIO → evento → URL); armar/desarmar simulan éxito.
 */
@Injectable()
export class StubCameraControlProvider extends CameraControlProvider {
  get name(): string {
    return 'stub-camera';
  }

  async snapshot(_device: CameraControlDevice): Promise<CameraControlResult> {
    return { dispatched: true, jpegBase64: STUB_JPEG_B64, mimeType: 'image/jpeg' };
  }

  async arm(_device: CameraControlDevice): Promise<CameraControlResult> {
    return { dispatched: true };
  }

  async disarm(_device: CameraControlDevice): Promise<CameraControlResult> {
    return { dispatched: true };
  }
}
