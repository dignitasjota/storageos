import { Injectable, NotFoundException } from '@nestjs/common';

import { CryptoService } from '../../common/crypto/crypto.service';
import { assertFacilityAllowed } from '../../common/facility-scope';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';

import { type CameraControlDevice } from './providers/camera-control-provider';
import { CameraControlRegistry } from './providers/camera-control.registry';

import type { CameraControlResultDto } from '@storageos/shared';

/**
 * Orquesta las acciones SALIENTES sobre un equipo de cámara (snapshot on-demand,
 * armar/desarmar): resuelve el provider por device, descifra las credenciales y,
 * en el snapshot, guarda el JPEG en MinIO + crea un evento `camera` para que
 * aparezca en el feed. Sin provider/hardware devuelve `dispatched:false` limpio.
 */
@Injectable()
export class CameraControlService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly files: FilesService,
    private readonly registry: CameraControlRegistry,
  ) {}

  async snapshot(
    tenantId: string,
    deviceId: string,
    facilityScope?: string[] | null,
  ): Promise<CameraControlResultDto> {
    const { device, control } = await this.resolve(tenantId, deviceId, facilityScope);
    if (!control) return { dispatched: false, message: 'provider_sin_acciones', snapshotUrl: null };

    const res = await control.snapshot(this.toControlDevice(device));
    if (!res.dispatched || !res.jpegBase64) {
      return { dispatched: res.dispatched, message: res.message ?? null, snapshotUrl: null };
    }
    // Guarda el JPEG capturado en MinIO + registra un evento (aparece en el feed).
    const mime = res.mimeType ?? 'image/jpeg';
    const key = this.files.buildCameraSnapshotKey(tenantId, deviceId, mime);
    await this.files.putObject({
      bucket: 'uploads',
      key,
      body: Buffer.from(res.jpegBase64, 'base64'),
      contentType: mime,
    });
    await this.prisma.withTenant(
      (tx) =>
        tx.cameraEvent.create({
          data: {
            tenantId,
            cameraDeviceId: deviceId,
            kind: 'camera',
            eventType: 'on_demand_snapshot',
            snapshotKey: key,
            metadata: { source: 'on_demand' },
          },
        }),
      tenantId,
    );
    return {
      dispatched: true,
      message: null,
      snapshotUrl: await this.files.getPresignedGetUrl('uploads', key, 300),
    };
  }

  async arm(
    tenantId: string,
    deviceId: string,
    facilityScope?: string[] | null,
  ): Promise<CameraControlResultDto> {
    return this.armOrDisarm(tenantId, deviceId, 'arm', facilityScope);
  }

  async disarm(
    tenantId: string,
    deviceId: string,
    facilityScope?: string[] | null,
  ): Promise<CameraControlResultDto> {
    return this.armOrDisarm(tenantId, deviceId, 'disarm', facilityScope);
  }

  private async armOrDisarm(
    tenantId: string,
    deviceId: string,
    action: 'arm' | 'disarm',
    facilityScope?: string[] | null,
  ): Promise<CameraControlResultDto> {
    const { device, control } = await this.resolve(tenantId, deviceId, facilityScope);
    if (!control) return { dispatched: false, message: 'provider_sin_acciones', snapshotUrl: null };
    const res = await control[action](this.toControlDevice(device));
    return { dispatched: res.dispatched, message: res.message ?? null, snapshotUrl: null };
  }

  private async resolve(
    tenantId: string,
    deviceId: string,
    facilityScope?: string[] | null,
  ): Promise<{
    device: {
      id: string;
      facilityId: string;
      provider: string;
      channel: number;
      controlUrl: string | null;
      controlSecretEncrypted: string | null;
      metadata: unknown;
    };
    control: ReturnType<CameraControlRegistry['resolve']>;
  }> {
    const device = await this.prisma.withTenant(
      (tx) =>
        tx.cameraDevice.findFirst({
          where: { id: deviceId },
          select: {
            id: true,
            facilityId: true,
            provider: true,
            channel: true,
            controlUrl: true,
            controlSecretEncrypted: true,
            metadata: true,
          },
        }),
      tenantId,
    );
    if (!device) {
      throw new NotFoundException({ code: 'camera_not_found', message: 'Cámara no encontrada' });
    }
    assertFacilityAllowed(facilityScope, device.facilityId);
    return { device, control: this.registry.resolve(device.provider) };
  }

  private toControlDevice(device: {
    id: string;
    provider: string;
    channel: number;
    controlUrl: string | null;
    controlSecretEncrypted: string | null;
    metadata: unknown;
  }): CameraControlDevice {
    return {
      id: device.id,
      channel: device.channel,
      controlUrl: device.controlUrl,
      controlSecret: device.controlSecretEncrypted
        ? this.crypto.decryptString(device.controlSecretEncrypted)
        : null,
    };
  }
}
