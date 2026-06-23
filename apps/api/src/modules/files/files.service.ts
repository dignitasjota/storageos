import { randomUUID } from 'node:crypto';

import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env.schema';

interface PresignArgs {
  bucket: 'plans' | 'uploads' | 'invoices' | 'reports' | 'public';
  key: string;
  contentType: string;
  contentLengthRange?: { min: number; max: number };
  /** TTL del uploadUrl en segundos. */
  expiresIn?: number;
}

/**
 * Cliente S3 compatible apuntando a MinIO. Genera URLs firmadas PUT para
 * que el frontend suba archivos directamente al storage sin pasar por la
 * API (ahorra ancho de banda + memoria del backend).
 *
 * Las claves se forman como `<tenantId>/<facilityId>/<floorId>-<uuid>.<ext>`
 * — incluyen el tenant para defensa en profundidad: incluso si alguien
 * acertara una key de otro tenant, las URLs firmadas son distintas.
 */
@Injectable()
export class FilesService implements OnModuleInit {
  private readonly logger = new Logger(FilesService.name);
  private readonly s3: S3Client;
  private readonly publicUrl: string;
  private readonly bucketMap: Record<PresignArgs['bucket'], string>;

  constructor(config: ConfigService<Env, true>) {
    const endpoint = `${config.get('MINIO_USE_SSL', { infer: true }) ? 'https' : 'http'}://${config.get('MINIO_ENDPOINT', { infer: true })}:${config.get('MINIO_PORT', { infer: true })}`;
    this.s3 = new S3Client({
      region: 'us-east-1', // MinIO ignora region pero el SDK la exige.
      endpoint,
      credentials: {
        accessKeyId: config.get('MINIO_ACCESS_KEY', { infer: true }),
        secretAccessKey: config.get('MINIO_SECRET_KEY', { infer: true }),
      },
      forcePathStyle: true, // MinIO requiere path-style (no virtual-hosted).
    });
    this.publicUrl = config.get('MINIO_PUBLIC_URL', { infer: true });
    this.bucketMap = {
      uploads: config.get('MINIO_BUCKET_UPLOADS', { infer: true }),
      invoices: config.get('MINIO_BUCKET_INVOICES', { infer: true }),
      plans: config.get('MINIO_BUCKET_PLANS', { infer: true }),
      reports: config.get('MINIO_BUCKET_REPORTS', { infer: true }),
      public: config.get('MINIO_BUCKET_PUBLIC', { infer: true }),
    };
  }

  async onModuleInit(): Promise<void> {
    // Asegura que los buckets existen al arrancar. En dev el sidecar
    // `createbuckets` ya los crea; este check es idempotente.
    for (const bucket of Object.values(this.bucketMap)) {
      try {
        await this.s3.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch {
        try {
          await this.s3.send(new CreateBucketCommand({ Bucket: bucket }));
          this.logger.log(`Bucket ${bucket} creado`);
        } catch (err) {
          this.logger.warn(`No se pudo crear bucket ${bucket}: ${(err as Error).message}`);
        }
      }
    }
  }

  /** Genera una URL firmada PUT para subir directamente desde el navegador. */
  async getPresignedPutUrl(args: PresignArgs): Promise<{ uploadUrl: string; expiresIn: number }> {
    const expiresIn = args.expiresIn ?? 300;
    const cmd = new PutObjectCommand({
      Bucket: this.bucketMap[args.bucket],
      Key: args.key,
      ContentType: args.contentType,
      ...(args.contentLengthRange?.max
        ? { ContentLength: undefined } // se valida en el cliente; MinIO no soporta size en presign
        : {}),
    });
    const uploadUrl = await getSignedUrl(this.s3, cmd, { expiresIn });
    return { uploadUrl, expiresIn };
  }

  /** Devuelve la URL publica (no firmada) para servir el objeto. */
  buildPublicUrl(bucket: PresignArgs['bucket'], key: string): string {
    const bucketName = this.bucketMap[bucket];
    return `${this.publicUrl}/${bucketName}/${key}`;
  }

  /**
   * URL firmada GET para servir un objeto de un bucket PRIVADO (evidencia:
   * fotos de check-out, documentos…). TTL corto; el cliente la usa en un <img>.
   */
  async getPresignedGetUrl(
    bucket: PresignArgs['bucket'],
    key: string,
    expiresIn = 300,
  ): Promise<string> {
    const cmd = new GetObjectCommand({ Bucket: this.bucketMap[bucket], Key: key });
    return getSignedUrl(this.s3, cmd, { expiresIn });
  }

  /** Genera una key para una foto de inspección de contrato (check-in/check-out). */
  buildInspectionPhotoKey(
    tenantId: string,
    contractId: string,
    kind: string,
    mimeType: string,
  ): string {
    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : 'webp';
    return `${tenantId}/contracts/${contractId}/${kind}/${randomUUID()}.${ext}`;
  }

  /** Genera una key unica para un plano de planta. */
  buildFloorPlanKey(
    tenantId: string,
    facilityId: string,
    floorId: string,
    mimeType: string,
  ): string {
    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : 'webp';
    return `${tenantId}/${facilityId}/floors/${floorId}-${randomUUID()}.${ext}`;
  }

  /** Genera una key unica para una imagen del local (landing pública). */
  buildFacilityImageKey(tenantId: string, facilityId: string, mimeType: string): string {
    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : 'webp';
    return `${tenantId}/${facilityId}/images/${randomUUID()}.${ext}`;
  }

  /** Genera una key para documentos del cliente. */
  buildCustomerDocumentKey(
    tenantId: string,
    customerId: string,
    mimeType: string,
    originalName: string,
  ): string {
    const ext = this.extFromMime(mimeType, originalName);
    return `${tenantId}/customers/${customerId}/${randomUUID()}.${ext}`;
  }

  /** Genera una key para PDFs de contratos. */
  buildContractPdfKey(tenantId: string, contractId: string): string {
    return `${tenantId}/contracts/${contractId}-${randomUUID()}.pdf`;
  }

  private extFromMime(mimeType: string, fallbackName: string): string {
    switch (mimeType) {
      case 'image/png':
        return 'png';
      case 'image/jpeg':
        return 'jpg';
      case 'image/webp':
        return 'webp';
      case 'application/pdf':
        return 'pdf';
      default: {
        const dot = fallbackName.lastIndexOf('.');
        return dot >= 0 ? fallbackName.slice(dot + 1).toLowerCase() : 'bin';
      }
    }
  }
}
