import { Injectable } from '@nestjs/common';

import { type CameraControlProvider } from './camera-control-provider';
import { DahuaCameraControlProvider } from './dahua-camera-control.provider';
import { StubCameraControlProvider } from './stub-camera-control.provider';

/**
 * Resuelve el provider de acciones salientes de cámara POR DEVICE (como el
 * registry de cerraduras). `generic` no soporta acciones salientes → null.
 */
@Injectable()
export class CameraControlRegistry {
  constructor(
    private readonly dahua: DahuaCameraControlProvider,
    private readonly stub: StubCameraControlProvider,
  ) {}

  resolve(provider?: string | null): CameraControlProvider | null {
    if (provider === 'dahua') return this.dahua;
    if (provider === 'stub') return this.stub;
    return null; // generic / desconocido → solo ingesta, sin acciones salientes
  }
}
